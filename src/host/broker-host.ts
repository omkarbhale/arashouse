// `BrokerHost`: the host driver on the real host. Each call runs the same guards as `FakeHost` on the
// WSL side first, then sends one request to the broker (ticket 20) through a `BrokerTransport` and
// turns the response into the driver's result or a `HostError`. `ms` is this side's round trip.
//
// The broker has `ping`, `hostInfo`, `readStamp`, `listSlots`, `baselineVerify`, `provisionSlot` and
// `destroySlot` so far. Every other method fails `Unreachable`, naming the ticket that adds its verb,
// so a reset waits (the slot stays dirty) rather than being quarantined for a verb the broker does
// not have yet. `baselineBuild`
// is never a verb: a baseline is built in an elevated session (ticket 24).

import { randomUUID } from "node:crypto";
import type { FlavorKey } from "../core/flavors.js";
import { parseSlotId, type SlotRef } from "../core/names.js";
import { redact } from "../core/redact.js";
import { ProtocolError, parseResponse, parseSlotStamp, verbTimeout, type BrokerRequest, type WireResult } from "../broker/protocol.js";
import type { BrokerTransport } from "./broker-transport.js";
import { systemClock, type Clock } from "./clock.js";
import type {
  BackupRef,
  BaselineBuildResult,
  BaselineVerifyOptions,
  BaselineVerifyResult,
  GoldenRef,
  HealthResult,
  HostDriver,
  HostInfo,
  HostInfoResult,
  HostMethod,
  HostResult,
  ListSlotsResult,
  ListedSlot,
  SecretRef,
  SlotStamp,
  SqlLoginInfo,
  StampResult,
  StartOptions,
} from "./driver.js";
import { HostError } from "./errors.js";
import { VERIFY_LEVELS, type ManifestDiff, type VerifyLevel } from "../core/manifest.js";
import { assertFlavorOwned, assertSlotOwned, type OwnedContext } from "./owned.js";

/** The ticket that adds each verb the broker does not have yet. */
const PENDING: Partial<Record<HostMethod, string>> = {
  quiesce: "30",
  resetTree: "30",
  resetDatabase: "31",
  startSlot: "33",
  stopSlot: "33",
  healthCheck: "32",
  writeStamp: "30",
  deployCode: "40",
  restoreDatabase: "39",
  backupDatabase: "43",
  setLeaseCredentials: "34",
};

export interface BrokerHostOptions {
  readonly clock?: Clock;
  /** The install root and probes the WSL-side guards use; the broker re-checks on Windows. */
  readonly owned?: OwnedContext;
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

function parseHostInfo(value: unknown): HostInfo {
  if (!isRecord(value)) throw new ProtocolError("info is missing");
  const { os, freeRamMb, freeDiskGb, brokerVersion, sqlReachable } = value;
  const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (typeof os !== "string" || !count(freeRamMb) || !count(freeDiskGb) || typeof brokerVersion !== "string" || typeof sqlReachable !== "boolean") {
    throw new ProtocolError("info has the wrong fields");
  }
  // A broker older than ticket 22 sends no sqlLogin; the doctor says so instead of guessing.
  const sqlLogin = parseSqlLogin(value.sqlLogin);
  const info: HostInfo = { os, freeRamMb: freeRamMb as number, freeDiskGb: freeDiskGb as number, brokerVersion, sqlReachable };
  return sqlLogin === undefined ? info : { ...info, sqlLogin };
}

function parseLevel(value: unknown): VerifyLevel {
  if (typeof value !== "string" || !(VERIFY_LEVELS as readonly string[]).includes(value)) throw new ProtocolError("level is not a verify level");
  return value as VerifyLevel;
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

  constructor(
    private readonly transport: BrokerTransport,
    options: BrokerHostOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.owned = options.owned ?? {};
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

  quiesce(slot: SlotRef): Promise<HostResult> {
    return this.pending("quiesce", this.slotGuard(slot));
  }

  resetTree(slot: SlotRef, _golden: GoldenRef): Promise<HostResult> {
    return this.pending("resetTree", this.slotGuard(slot));
  }

  resetDatabase(slot: SlotRef, _backup: BackupRef): Promise<HostResult> {
    return this.pending("resetDatabase", this.slotGuard(slot));
  }

  startSlot(slot: SlotRef, _options: StartOptions): Promise<HostResult> {
    return this.pending("startSlot", this.slotGuard(slot));
  }

  stopSlot(slot: SlotRef): Promise<HostResult> {
    return this.pending("stopSlot", this.slotGuard(slot));
  }

  deployCode(slot: SlotRef, _stagedPath: string): Promise<HostResult> {
    return this.pending("deployCode", this.slotGuard(slot));
  }

  restoreDatabase(slot: SlotRef, _stagedBak: string): Promise<HostResult> {
    return this.pending("restoreDatabase", this.slotGuard(slot));
  }

  backupDatabase(slot: SlotRef, _stagedPath: string): Promise<HostResult> {
    return this.pending("backupDatabase", this.slotGuard(slot));
  }

  healthCheck(slot: SlotRef): Promise<HealthResult> {
    return this.pending("healthCheck", this.slotGuard(slot));
  }

  writeStamp(slot: SlotRef, _stamp: SlotStamp): Promise<HostResult> {
    return this.pending("writeStamp", this.slotGuard(slot));
  }

  setLeaseCredentials(slot: SlotRef, _secretRef: SecretRef): Promise<HostResult> {
    return this.pending("setLeaseCredentials", this.slotGuard(slot));
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
      return { ok: result.ok, ms, detail: result.detail, level: parseLevel(result.level), ...(result.diff === undefined ? {} : { diff: parseDiff(result.diff) }) };
    } catch (err) {
      throw malformed("baselineVerify", (err as Error).message);
    }
  }
}
