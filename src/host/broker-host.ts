// `BrokerHost`: the host driver on the real host. Each call runs the same guards as `FakeHost` on the
// WSL side first, then sends one request to the broker (ticket 20) through a `BrokerTransport` and
// turns the response into the driver's result or a `HostError`. `ms` is this side's round trip.
//
// The broker has `ping`, `hostInfo`, `readStamp`, `listSlots`, `baselineVerify`, `provisionSlot`,
// `destroySlot`, `startSlot`, `stopSlot`, `quiesce`, `resetTree`, `writeStamp`, `resetDatabase`, `setLeaseCredentials` and `healthCheck` so far. Every other
// method fails `Unreachable`, naming the ticket that adds its verb, so a reset waits (the slot stays
// dirty) rather than being quarantined for a verb the broker does not have yet. `baselineBuild` is
// never a verb: a baseline is built in an elevated session (ticket 24).

import { randomUUID } from "node:crypto";
import type { FlavorKey } from "../core/flavors.js";
import type { LicenceStatus } from "../core/licence.js";
import { isSecretName, parseSlotId, slotId, type SlotRef } from "../core/names.js";
import { redact } from "../core/redact.js";
import type { SecretStore } from "../core/secret-store.js";
import { ProtocolError, parseResponse, parseSlotStamp, verbTimeout, type BrokerRequest, type WireResult } from "../broker/protocol.js";
import type { BrokerTransport } from "./broker-transport.js";
import { systemClock, type Clock } from "./clock.js";
import type {
  BackupRef,
  BaselineBuildResult,
  BaselineVerifyOptions,
  BaselineVerifyResult,
  GoldenRef,
  HealthCheckEntry,
  HealthResult,
  HostDriver,
  HostInfo,
  HostInfoResult,
  HostMethod,
  HostResult,
  ListSlotsResult,
  ListedSlot,
  MarkerReading,
  SecretRef,
  SlotStamp,
  SqlLoginInfo,
  StampResult,
  StartOptions,
} from "./driver.js";
import { HostError } from "./errors.js";
import { VERIFY_LEVELS, type ManifestDiff, type VerifyLevel } from "../core/manifest.js";
import { assertFlavorOwned, assertGoldenPath, assertSlotOwned, assertStagedPath, type OwnedContext } from "./owned.js";

/** The ticket that adds each verb the broker does not have yet. */
const PENDING: Partial<Record<HostMethod, string>> = {
  deployCode: "40",
  restoreDatabase: "39",
  backupDatabase: "43",
};

export interface BrokerHostOptions {
  readonly clock?: Clock;
  /** The install root and probes the WSL-side guards use; the broker re-checks on Windows. */
  readonly owned?: OwnedContext;
  /**
   * Where a `SecretRef` is looked up on this side: the lease-file store, which holds the lease's password
   * (`lease-<lease_id>`). Without one, `setLeaseCredentials` is refused.
   */
  readonly secrets?: SecretStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(verb: HostMethod, why: string): HostError {
  return new HostError("Unreachable", `the broker's answer to ${verb} is malformed: ${why}`);
}

function parseSqlLogin(value: unknown): SqlLoginInfo | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isRecord(value)) throw new ProtocolError("info.sqlLogin is not an object");
  const { login, sysadmin, dbcreator, procedures } = value;
  if (typeof login !== "string" || typeof sysadmin !== "boolean" || typeof dbcreator !== "boolean" || !Number.isInteger(procedures) || (procedures as number) < 0) {
    throw new ProtocolError("info.sqlLogin has the wrong fields");
  }
  return { login, sysadmin, dbcreator, procedures: procedures as number };
}

/** The licence lines' presence: a line and a boolean each, nothing else (ticket 34b). */
function parseLicences(value: unknown): readonly LicenceStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ProtocolError("info.licences is not a list");
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || typeof entry.line !== "string" || typeof entry.present !== "boolean") {
      throw new ProtocolError("info.licences has the wrong fields");
    }
    return { line: entry.line, present: entry.present };
  });
}

function parseHostInfo(value: unknown): HostInfo {
  if (!isRecord(value)) throw new ProtocolError("info is missing");
  const { os, freeRamMb, freeDiskGb, brokerVersion, sqlReachable } = value;
  const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (typeof os !== "string" || !count(freeRamMb) || !count(freeDiskGb) || typeof brokerVersion !== "string" || typeof sqlReachable !== "boolean") {
    throw new ProtocolError("info has the wrong fields");
  }
  // A broker older than ticket 22 sends no sqlLogin; the doctor says so instead of guessing.
  const sqlLogin = parseSqlLogin(value.sqlLogin);
  const licences = parseLicences(value.licences);
  const info: HostInfo = { os, freeRamMb: freeRamMb as number, freeDiskGb: freeDiskGb as number, brokerVersion, sqlReachable };
  return { ...info, ...(sqlLogin === undefined ? {} : { sqlLogin }), ...(licences === undefined ? {} : { licences }) };
}

function parseLevel(value: unknown): VerifyLevel {
  if (typeof value !== "string" || !(VERIFY_LEVELS as readonly string[]).includes(value)) throw new ProtocolError("level is not a verify level");
  return value as VerifyLevel;
}

/** The health check's entries as the broker sends them: a name, a boolean, a detail and the time. */
function parseChecks(value: unknown): HealthCheckEntry[] {
  if (!Array.isArray(value)) throw new ProtocolError("checks is not a list");
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.ok !== "boolean" || typeof entry.detail !== "string") {
      throw new ProtocolError("a check has the wrong fields");
    }
    const ms = typeof entry.ms === "number" && Number.isFinite(entry.ms) && entry.ms >= 0 ? entry.ms : undefined;
    return { name: entry.name, ok: entry.ok, detail: redact(entry.detail), ...(ms === undefined ? {} : { ms }) };
  });
}

/** The database marker the health check read: two strings or nulls; null when the database could not be read. */
function parseMarker(value: unknown): MarkerReading | null {
  if (value === null || value === undefined) return null;
  const text = (v: unknown) => v === null || (typeof v === "string" && v.length <= 200);
  if (!isRecord(value) || !text(value.goldenHash) || !text(value.resetAt)) throw new ProtocolError("marker has the wrong fields");
  return { goldenHash: value.goldenHash as string | null, resetAt: value.resetAt as string | null };
}

/** A manifest diff as the broker sends it: counts and paths only. */
function parseDiff(value: unknown): ManifestDiff {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !isRecord(value.counts) || !Array.isArray(value.problems)) {
    throw new ProtocolError("diff has the wrong fields");
  }
  return value as unknown as ManifestDiff;
}

export class BrokerHost implements HostDriver {
  private readonly clock: Clock;
  private readonly owned: OwnedContext;
  private readonly secrets: SecretStore | undefined;

  constructor(
    private readonly transport: BrokerTransport,
    options: BrokerHostOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.owned = options.owned ?? {};
    this.secrets = options.secrets;
  }

  /** One round trip; returns the result and the time it took. */
  private async call(
    verb: HostMethod,
    target: { slot?: SlotRef; flavor?: FlavorKey } = {},
    args?: Readonly<Record<string, unknown>>,
  ): Promise<{ result: WireResult; ms: number }> {
    const request: BrokerRequest = { id: randomUUID(), verb, ...target, ...(args ? { args } : {}) };
    const started = this.clock.now();
    const raw = await this.transport.call(request, verbTimeout(verb));
    const ms = Math.max(0, this.clock.now() - started);
    let response;
    try {
      response = parseResponse(raw, request.id);
    } catch (err) {
      throw malformed(verb, (err as Error).message);
    }
    if (!response.ok) throw new HostError(response.error.kind, redact(response.error.message));
    return { result: { ...response.result, detail: redact(response.result.detail) }, ms };
  }

  private pending(verb: HostMethod, guard: () => void): Promise<never> {
    return Promise.resolve()
      .then(guard)
      .then(() => {
        throw new HostError("Unreachable", `the broker has no ${verb} verb yet (ticket ${PENDING[verb] ?? "?"})`);
      });
  }

  private slotGuard(slot: SlotRef): () => void {
    return () => void assertSlotOwned(slot, this.owned);
  }

  /** The slot, then the staged path, as `FakeHost` checks them (here without the lease id, which only the stamp knows). */
  private stagedGuard(slot: SlotRef, path: string): () => void {
    return () => {
      assertSlotOwned(slot, this.owned);
      assertStagedPath(slot, path, this.owned);
    };
  }

  async ping(): Promise<HostResult> {
    const { result, ms } = await this.call("ping");
    return { ok: result.ok, ms, detail: result.detail };
  }

  async hostInfo(): Promise<HostInfoResult> {
    const { result, ms } = await this.call("hostInfo");
    try {
      return { ok: result.ok, ms, detail: result.detail, info: parseHostInfo(result.info) };
    } catch (err) {
      throw malformed("hostInfo", (err as Error).message);
    }
  }

  async readStamp(slot: SlotRef): Promise<StampResult> {
    assertSlotOwned(slot, this.owned);
    const { result, ms } = await this.call("readStamp", { slot: { flavor: slot.flavor, slot: slot.slot } });
    try {
      const stamp = result.stamp === null ? null : parseSlotStamp(result.stamp, slot);
      return { ok: result.ok, ms, detail: result.detail, stamp };
    } catch (err) {
      throw malformed("readStamp", (err as Error).message);
    }
  }

  async listSlots(): Promise<ListSlotsResult> {
    const { result, ms } = await this.call("listSlots");
    if (!Array.isArray(result.slots)) throw malformed("listSlots", "slots is not a list");
    const slots: ListedSlot[] = [];
    for (const entry of result.slots as unknown[]) {
      try {
        if (!isRecord(entry) || !isRecord(entry.slot)) throw new ProtocolError("an entry has no slot");
        const { flavor, slot: number } = entry.slot;
        // Round-trips through the slot id, so only a registered (flavor, number) is accepted.
        const slot = parseSlotId(`${String(flavor)}-${String(number).padStart(2, "0")}`);
        if (slot.slot !== number) throw new ProtocolError("an entry's slot number is not an integer");
        const stamp: SlotStamp | null = entry.stamp === null ? null : parseSlotStamp(entry.stamp, slot);
        slots.push({ slot, stamp });
      } catch (err) {
        throw malformed("listSlots", (err as Error).message);
      }
    }
    return { ok: result.ok, ms, detail: result.detail, slots };
  }

  async provisionSlot(slot: SlotRef): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    const { result, ms } = await this.call("provisionSlot", { slot: { flavor: slot.flavor, slot: slot.slot } });
    return { ok: result.ok, ms, detail: result.detail };
  }

  async destroySlot(slot: SlotRef): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    const { result, ms } = await this.call("destroySlot", { slot: { flavor: slot.flavor, slot: slot.slot } });
    return { ok: result.ok, ms, detail: result.detail };
  }

  async quiesce(slot: SlotRef): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    const { result, ms } = await this.call("quiesce", { slot: { flavor: slot.flavor, slot: slot.slot } });
    return { ok: result.ok, ms, detail: result.detail };
  }

  async resetTree(slot: SlotRef, golden: GoldenRef): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    if (golden.flavor !== slot.flavor) throw new HostError("Refused", `the ${golden.flavor} golden is not slot ${slotId(slot)}'s`);
    const { result, ms } = await this.call("resetTree", { slot: { flavor: slot.flavor, slot: slot.slot } }, { hash: golden.hash });
    return { ok: result.ok, ms, detail: result.detail };
  }

  async resetDatabase(slot: SlotRef, backup: BackupRef): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    if (backup.flavor !== slot.flavor) throw new HostError("Refused", `the backup is of flavor ${backup.flavor}, not ${slot.flavor}`);
    const file = assertGoldenPath(slot, backup.file, this.owned);
    const { result, ms } = await this.call("resetDatabase", { slot: { flavor: slot.flavor, slot: slot.slot } }, { file, hash: backup.hash });
    return { ok: result.ok, ms, detail: result.detail };
  }

  async startSlot(slot: SlotRef, options: StartOptions): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    const { result, ms } = await this.call("startSlot", { slot: { flavor: slot.flavor, slot: slot.slot } }, { agent: options.agent === true });
    return { ok: result.ok, ms, detail: result.detail };
  }

  async stopSlot(slot: SlotRef): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    const { result, ms } = await this.call("stopSlot", { slot: { flavor: slot.flavor, slot: slot.slot } });
    return { ok: result.ok, ms, detail: result.detail };
  }

  deployCode(slot: SlotRef, stagedPath: string): Promise<HostResult> {
    return this.pending("deployCode", this.stagedGuard(slot, stagedPath));
  }

  restoreDatabase(slot: SlotRef, stagedBak: string): Promise<HostResult> {
    return this.pending("restoreDatabase", this.stagedGuard(slot, stagedBak));
  }

  backupDatabase(slot: SlotRef, stagedPath: string): Promise<HostResult> {
    return this.pending("backupDatabase", this.stagedGuard(slot, stagedPath));
  }

  async healthCheck(slot: SlotRef): Promise<HealthResult> {
    assertSlotOwned(slot, this.owned);
    const { result, ms } = await this.call("healthCheck", { slot: { flavor: slot.flavor, slot: slot.slot } });
    try {
      return { ok: result.ok, ms, detail: result.detail, checks: parseChecks(result.checks), marker: parseMarker(result.marker) };
    } catch (err) {
      throw malformed("healthCheck", (err as Error).message);
    }
  }

  async writeStamp(slot: SlotRef, stamp: SlotStamp): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    const { result, ms } = await this.call("writeStamp", { slot: { flavor: slot.flavor, slot: slot.slot } }, { stamp });
    return { ok: result.ok, ms, detail: result.detail };
  }

  /**
   * The handle is looked up here, in the lease-file store, and the password goes to the broker on the request line
   * (the client's stdin, then the pipe): never in an argument list, and the broker's audit log records no arguments.
   */
  async setLeaseCredentials(slot: SlotRef, secretRef: SecretRef): Promise<HostResult> {
    assertSlotOwned(slot, this.owned);
    const name = secretRef?.secretRef;
    if (typeof name !== "string" || !isSecretName(name)) throw new HostError("Refused", "a secret handle is required");
    if (this.secrets === undefined) throw new HostError("Refused", "this host has no store to look the lease's password up in");
    const password = await this.secrets.get(name);
    if (password === undefined || password.kind !== "lease-password") throw new HostError("Refused", `no lease password is stored as ${name}`);
    const { result, ms } = await this.call("setLeaseCredentials", { slot: { flavor: slot.flavor, slot: slot.slot } }, { password: password.reveal() });
    return { ok: result.ok, ms, detail: result.detail };
  }

  /** Never through the broker: its SQL login may not create the build database (ticket 22). The build runs elevated (docs/baselines.md). */
  async baselineBuild(flavor: FlavorKey): Promise<BaselineBuildResult> {
    assertFlavorOwned(flavor, this.owned);
    throw new HostError("Refused", `a baseline is built in an elevated session, not by the broker: run \`arashouse baseline build ${flavor}\` and the script it writes`);
  }

  async baselineVerify(flavor: FlavorKey, options: BaselineVerifyOptions = {}): Promise<BaselineVerifyResult> {
    assertFlavorOwned(flavor, this.owned);
    const level = options.level ?? "golden";
    const { result, ms } = await this.call("baselineVerify", { flavor }, { level });
    try {
      if (result.goldenHash !== undefined && (typeof result.goldenHash !== "string" || !/^[0-9a-f]{64}$/.test(result.goldenHash))) {
        throw new ProtocolError("goldenHash is not a manifest hash");
      }
      return {
        ok: result.ok,
        ms,
        detail: result.detail,
        level: parseLevel(result.level),
        ...(result.diff === undefined ? {} : { diff: parseDiff(result.diff) }),
        ...(result.goldenHash === undefined ? {} : { goldenHash: result.goldenHash as string }),
      };
    } catch (err) {
      throw malformed("baselineVerify", (err as Error).message);
    }
  }
}
