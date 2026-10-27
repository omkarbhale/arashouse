// FakeHost: the host driver with no Windows behind it. In-memory slots, injectable faults (fail a
// step on its Nth call, hang, slow), a clock the test controls, and a record of every call in
// order. It runs the same guards as the real host, so a call that names `OLM_Local` is refused the
// same way. Lease and reset logic is tested against this; the contract suite (test/host-contract.ts)
// holds it to the same behaviour as the broker-backed driver.

import { createHash } from "node:crypto";
import { FLAVOR_KEYS, isFlavorKey, type FlavorKey } from "../core/flavors.js";
import { assertValidRoot } from "../core/guards.js";
import { VERIFY_LEVELS } from "../core/manifest.js";
import { DEFAULT_INSTALL_ROOT, goldenDir, slotId, type SlotRef } from "../core/names.js";
import { ADMIN_PROCEDURES, POOL_LOGIN } from "../core/setup-sql.js";
import { FakeClock } from "./clock.js";
import {
  HOST_METHODS,
  type BackupRef,
  type BaselineBuildResult,
  type GoldenRef,
  type HealthCheckEntry,
  type HealthResult,
  type HostDriver,
  type HostInfo,
  type HostInfoResult,
  type HostMethod,
  type BaselineVerifyOptions,
  type BaselineVerifyResult,
  type HostResult,
  type ListSlotsResult,
  type SecretRef,
  type SlotStamp,
  type StampResult,
  type StartOptions,
} from "./driver.js";
import { HostError, type HostErrorKind } from "./errors.js";
import {
  assertFlavorOwned,
  assertGoldenPath,
  assertSlotOwned,
  assertStagedPath,
  guarded,
  type OwnedContext,
} from "./owned.js";

/** The golden manifest hash the fake gives a flavor. Deterministic, and not a secret. */
export function fakeGoldenHash(flavor: FlavorKey): string {
  return createHash("sha256").update(`fake-golden:${flavor}`).digest("hex");
}

// ---- fault injection ---------------------------------------------------------------------------

interface FaultBase {
  /** The step to fault. */
  readonly method: HostMethod;
  /** Only calls for this slot count and fault; omit for any slot. */
  readonly slot?: SlotRef;
  /** Which matching call faults first, counted from 1 from the moment the fault is injected. Default 1. */
  readonly nth?: number;
  /** How many consecutive matching calls fault, from `nth`. Default 1. `Infinity` faults every one. */
  readonly times?: number;
}

export type Fault = FaultBase &
  (
    | {
        /** Throw a `HostError` and leave the slot unchanged. */
        readonly kind: "fail";
        /** Default `Retryable`. */
        readonly error?: HostErrorKind;
        readonly message?: string;
      }
    | {
        /** Advance the clock by `ms`, then carry on and succeed. */
        readonly kind: "slow";
        readonly ms: number;
      }
    | {
        /** Never answer until `releaseHangs()`, then carry on and succeed. */
        readonly kind: "hang";
      }
  );

interface ActiveFault {
  readonly fault: Fault;
  seen: number;
}

// ---- the call record ---------------------------------------------------------------------------

export type CallOutcome = "ok" | "not-ok" | "error" | "hung";

/** What the call record holds in place of a credential handle. */
const HANDLE_MARK = "[handle]";

/** One host call. It holds no secret: a credential handle is recorded as `[handle]`. */
export interface CallRecord {
  readonly seq: number;
  readonly method: HostMethod;
  /** The slot id (`23-02`), the flavor for a baseline call, or null. */
  readonly target: string | null;
  /** Non-secret arguments: paths, flags. */
  readonly args: Readonly<Record<string, string | boolean>>;
  /** Clock time at the start of the call. */
  readonly at: number;
  outcome: CallOutcome;
  /** The `HostError` kind when `outcome` is "error" and the error was a `HostError`. */
  error?: HostErrorKind;
  ms: number;
}

// ---- slots -------------------------------------------------------------------------------------

/** What the fake knows about one provisioned slot. */
export interface FakeSlotState {
  readonly slot: SlotRef;
  /** Applications are online (the opposite of quiesced or stopped). */
  online: boolean;
  agent: boolean;
  /** The golden hash the code tree matches. */
  treeHash: string | null;
  /** Something changed the tree since the last reset (a deployed build, an extra file). */
  treeDirty: boolean;
  /** The database marker; null when the database is not a golden restore. */
  dbMarker: string | null;
  stamp: SlotStamp | null;
  /** The per-lease credentials' handle, never the secret. */
  credentials: SecretRef | null;
  deployed: string[];
  restored: string[];
  backedUp: string[];
}

export type DirtyPart = "tree" | "database" | "stamp";

export interface FakeHostOptions {
  readonly root?: string;
  readonly clock?: FakeClock;
  /** Milliseconds every call takes on the fake clock. Default 0. */
  readonly latencyMs?: number;
  /** Flavors whose baseline is already built. */
  readonly baselines?: readonly FlavorKey[];
  readonly info?: Partial<HostInfo>;
  /** Reports a junction or other reparse point, as the real host would for a path segment. */
  readonly isReparsePoint?: (path: string) => boolean;
}

const DEFAULT_INFO: HostInfo = {
  os: "Windows 11 (fake)",
  freeRamMb: 16384,
  freeDiskGb: 200,
  brokerVersion: "0.0.0-fake",
  sqlReachable: true,
  sqlLogin: { login: POOL_LOGIN, sysadmin: false, dbcreator: false, procedures: ADMIN_PROCEDURES.length },
};

interface CallTarget {
  readonly slot?: SlotRef;
  readonly flavor?: FlavorKey;
  readonly args?: Readonly<Record<string, string | boolean>>;
}

/** A label for the record that survives a slot record the guards are about to refuse. */
function targetLabel(target: CallTarget): string | null {
  if (!target.slot) return target.flavor === undefined ? null : String(target.flavor);
  try {
    return slotId(target.slot);
  } catch {
    return `${String(target.slot.flavor)}/${String(target.slot.slot)}`;
  }
}

export class FakeHost implements HostDriver {
  readonly clock: FakeClock;
  readonly root: string;
  private readonly latencyMs: number;
  private readonly owned: OwnedContext;
  private readonly slots = new Map<string, FakeSlotState>();
  private readonly promoting = new Set<FlavorKey>();
  private readonly baselines: Set<FlavorKey>;
  private info: HostInfo;
  private reachable = true;
  private faults: ActiveFault[] = [];
  private hangs: (() => void)[] = [];
  private readonly record: CallRecord[] = [];

  constructor(options: FakeHostOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.root = assertValidRoot(options.root ?? DEFAULT_INSTALL_ROOT);
    this.latencyMs = options.latencyMs ?? 0;
    this.baselines = new Set(options.baselines ?? []);
    this.info = { ...DEFAULT_INFO, ...options.info };
    this.owned = { root: this.root, isReparsePoint: options.isReparsePoint };
  }

  // ---- test controls ---------------------------------------------------------------------------

  /** Every call so far, in order, refused ones included. */
  get calls(): readonly CallRecord[] {
    return this.record;
  }

  /** The methods called, in order. */
  get callLog(): readonly HostMethod[] {
    return this.record.map((c) => c.method);
  }

  injectFault(fault: Fault): void {
    if (!(HOST_METHODS as readonly string[]).includes(fault.method)) throw new Error(`unknown host method "${fault.method}"`);
    if (fault.nth !== undefined && (!Number.isInteger(fault.nth) || fault.nth < 1)) throw new Error("nth counts from 1");
    this.faults.push({ fault, seen: 0 });
  }

  clearFaults(): void {
    this.faults = [];
  }

  /** Answers every call that is hanging; each then carries on. */
  releaseHangs(): void {
    const pending = this.hangs;
    this.hangs = [];
    for (const release of pending) release();
  }

  get hangingCalls(): number {
    return this.hangs.length;
  }

  /** While false, every call throws `Unreachable`. */
  setReachable(reachable: boolean): void {
    this.reachable = reachable;
  }

  setHostInfo(info: Partial<HostInfo>): void {
    this.info = { ...this.info, ...info };
  }

  /** Dirties one part of a slot: an extra file in the tree, a database that is not golden, a stamp from another golden. */
  dirty(slot: SlotRef, part: DirtyPart): void {
    const state = this.stateOf(slot);
    if (part === "tree") state.treeDirty = true;
    else if (part === "database") state.dbMarker = null;
    else if (state.stamp) state.stamp = { ...state.stamp, goldenHash: "other-golden" };
    else throw new Error(`slot ${slotId(slot)} has no stamp to dirty`);
  }

  /** A copy of what the fake holds for a slot, or undefined if it is not provisioned. */
  inspect(slot: SlotRef): Readonly<FakeSlotState> | undefined {
    const state = this.slots.get(slotId(slot));
    return state ? structuredClone(state) : undefined;
  }

  /** Marks a flavor's golden as being moved into place (the build's promote marker) or not. */
  setPromoting(flavor: FlavorKey, on: boolean): void {
    if (on) this.promoting.add(flavor);
    else this.promoting.delete(flavor);
  }

  /** The golden tree reference the fake accepts for a flavor. */
  golden(flavor: FlavorKey): GoldenRef {
    if (this.promoting.has(flavor)) throw new HostError("Retryable", `the ${flavor} golden is being promoted`);
    return { flavor, hash: fakeGoldenHash(flavor) };
  }

  /** The golden backup reference the fake accepts for a flavor. */
  backup(flavor: FlavorKey): BackupRef {
    if (this.promoting.has(flavor)) throw new HostError("Retryable", `the ${flavor} golden is being promoted`);
    return { flavor, file: `${goldenDir(flavor, this.root)}\\Core.bak`, hash: fakeGoldenHash(flavor) };
  }

  // ---- the driver ------------------------------------------------------------------------------

  ping(): Promise<HostResult> {
    return this.call("ping", {}, () => {}, () => ({ ok: true, detail: "pong" }));
  }

  hostInfo(): Promise<HostInfoResult> {
    return this.call<HostInfoResult>("hostInfo", {}, () => {}, () => ({
      ok: true,
      detail: `${this.info.os}, broker ${this.info.brokerVersion}`,
      info: { ...this.info },
    }));
  }

  provisionSlot(slot: SlotRef): Promise<HostResult> {
    return this.call("provisionSlot", { slot }, () => assertSlotOwned(slot, this.owned), () => {
      const id = slotId(slot);
      if (this.slots.has(id)) throw new HostError("Refused", `slot ${id} is already provisioned`);
      const hash = fakeGoldenHash(slot.flavor);
      this.slots.set(id, {
        slot: { flavor: slot.flavor, slot: slot.slot },
        online: true,
        agent: false,
        treeHash: hash,
        treeDirty: false,
        dbMarker: hash,
        stamp: this.stampOf(slot, hash),
        credentials: null,
        deployed: [],
        restored: [],
        backedUp: [],
      });
      return { ok: true, detail: `provisioned ${id}` };
    });
  }

  destroySlot(slot: SlotRef): Promise<HostResult> {
    return this.call("destroySlot", { slot }, () => assertSlotOwned(slot, this.owned), () => {
      this.stateOf(slot);
      this.slots.delete(slotId(slot));
      return { ok: true, detail: `destroyed ${slotId(slot)}` };
    });
  }

  quiesce(slot: SlotRef): Promise<HostResult> {
    return this.call("quiesce", { slot }, () => assertSlotOwned(slot, this.owned), () => {
      const state = this.stateOf(slot);
      state.agent = false;
      state.online = false;
      return { ok: true, detail: `quiesced ${slotId(slot)}` };
    });
  }

  resetTree(slot: SlotRef, golden: GoldenRef): Promise<HostResult> {
    return this.call(
      "resetTree",
      { slot, args: { flavor: golden.flavor } },
      () => {
        assertSlotOwned(slot, this.owned);
        this.assertSameFlavor(slot, golden.flavor);
      },
      () => {
        const state = this.stateOf(slot);
        if (state.online) throw new HostError("Refused", `slot ${slotId(slot)} is not quiesced`);
        state.treeHash = golden.hash;
        state.treeDirty = false;
        state.stamp = this.stampOf(slot, golden.hash);
        return { ok: true, detail: `tree of ${slotId(slot)} reset to golden` };
      },
    );
  }

  resetDatabase(slot: SlotRef, backup: BackupRef): Promise<HostResult> {
    return this.call(
      "resetDatabase",
      { slot, args: { file: backup.file } },
      () => {
        assertSlotOwned(slot, this.owned);
        this.assertSameFlavor(slot, backup.flavor);
        assertGoldenPath(slot, backup.file, this.owned);
      },
      () => {
        const state = this.stateOf(slot);
        state.dbMarker = backup.hash;
        // The golden database carries none of a lease's credentials (ticket 34).
        state.credentials = null;
        return { ok: true, detail: `database of ${slotId(slot)} restored from golden` };
      },
    );
  }

  startSlot(slot: SlotRef, options: StartOptions): Promise<HostResult> {
    return this.call(
      "startSlot",
      { slot, args: { agent: options.agent === true } },
      () => assertSlotOwned(slot, this.owned),
      () => {
        const state = this.stateOf(slot);
        state.online = true;
        state.agent = options.agent === true;
        return { ok: true, detail: `started ${slotId(slot)}${state.agent ? " with its agent" : ""}` };
      },
    );
  }

  stopSlot(slot: SlotRef): Promise<HostResult> {
    return this.call("stopSlot", { slot }, () => assertSlotOwned(slot, this.owned), () => {
      const state = this.stateOf(slot);
      state.agent = false;
      state.online = false;
      return { ok: true, detail: `stopped ${slotId(slot)}` };
    });
  }

  deployCode(slot: SlotRef, stagedPath: string): Promise<HostResult> {
    return this.call(
      "deployCode",
      { slot, args: { path: stagedPath } },
      () => {
        assertSlotOwned(slot, this.owned);
        assertStagedPath(slot, stagedPath, this.owned, this.stateOf(slot).stamp?.leaseId);
      },
      () => {
        const state = this.stateOf(slot);
        state.treeDirty = true;
        state.deployed.push(stagedPath);
        return { ok: true, detail: `deployed code into ${slotId(slot)}` };
      },
    );
  }

  restoreDatabase(slot: SlotRef, stagedBak: string): Promise<HostResult> {
    return this.call(
      "restoreDatabase",
      { slot, args: { path: stagedBak } },
      () => {
        assertSlotOwned(slot, this.owned);
        assertStagedPath(slot, stagedBak, this.owned, this.stateOf(slot).stamp?.leaseId);
      },
      () => {
        const state = this.stateOf(slot);
        state.dbMarker = null;
        state.restored.push(stagedBak);
        return { ok: true, detail: `restored a backup over the database of ${slotId(slot)}` };
      },
    );
  }

  backupDatabase(slot: SlotRef, stagedPath: string): Promise<HostResult> {
    return this.call(
      "backupDatabase",
      { slot, args: { path: stagedPath } },
      () => {
        assertSlotOwned(slot, this.owned);
        assertStagedPath(slot, stagedPath, this.owned, this.stateOf(slot).stamp?.leaseId);
      },
      () => {
        this.stateOf(slot).backedUp.push(stagedPath);
        return { ok: true, detail: `backed up the database of ${slotId(slot)}` };
      },
    );
  }

  healthCheck(slot: SlotRef): Promise<HealthResult> {
    return this.call<HealthResult>("healthCheck", { slot }, () => assertSlotOwned(slot, this.owned), () => {
      const state = this.stateOf(slot);
      const goldenHash = state.stamp?.goldenHash ?? null;
      const entry = (name: string, ok: boolean, detail: string): HealthCheckEntry => ({ name, ok, detail });
      const checks: HealthCheckEntry[] = [
        entry("applications-online", state.online, state.online ? "online" : "offline"),
        entry("stamp", state.stamp !== null, state.stamp ? "present" : "missing"),
        entry(
          "tree-matches-stamp",
          goldenHash !== null && state.treeHash === goldenHash,
          state.treeHash === goldenHash ? "same golden" : "a different golden",
        ),
        entry(
          "database-marker-matches-stamp",
          goldenHash !== null && state.dbMarker === goldenHash,
          state.dbMarker === null ? "marker missing" : state.dbMarker === goldenHash ? "same golden" : "a different golden",
        ),
        entry("tree-clean", !state.treeDirty, state.treeDirty ? "files differ from golden" : "matches golden"),
      ];
      const failed = checks.filter((c) => !c.ok).map((c) => c.name);
      return {
        ok: failed.length === 0,
        detail: failed.length === 0 ? `${checks.length} checks passed` : `failed: ${failed.join(", ")}`,
        checks,
      };
    });
  }

  readStamp(slot: SlotRef): Promise<StampResult> {
    return this.call<StampResult>("readStamp", { slot }, () => assertSlotOwned(slot, this.owned), () => {
      const state = this.stateOf(slot);
      return {
        ok: true,
        detail: state.stamp ? `stamp of ${slotId(slot)}` : `no stamp for ${slotId(slot)}`,
        stamp: state.stamp ? structuredClone(state.stamp) : null,
      };
    });
  }

  writeStamp(slot: SlotRef, stamp: SlotStamp): Promise<HostResult> {
    return this.call("writeStamp", { slot }, () => assertSlotOwned(slot, this.owned), () => {
      const state = this.stateOf(slot);
      if (stamp.slotId !== slotId(slot) || stamp.flavor !== slot.flavor) {
        throw new HostError("Refused", `the stamp does not belong to slot ${slotId(slot)}`);
      }
      state.stamp = structuredClone(stamp);
      return { ok: true, detail: `wrote the stamp of ${slotId(slot)}` };
    });
  }

  listSlots(): Promise<ListSlotsResult> {
    return this.call<ListSlotsResult>("listSlots", {}, () => {}, () => {
      const slots = [...this.slots.values()]
        .sort((a, b) => FLAVOR_KEYS.indexOf(a.slot.flavor) - FLAVOR_KEYS.indexOf(b.slot.flavor) || a.slot.slot - b.slot.slot)
        .map((s) => ({ slot: { ...s.slot }, stamp: s.stamp ? structuredClone(s.stamp) : null }));
      return { ok: true, detail: `${slots.length} slots`, slots };
    });
  }

  setLeaseCredentials(slot: SlotRef, secretRef: SecretRef): Promise<HostResult> {
    return this.call(
      "setLeaseCredentials",
      { slot, args: { secretRef: HANDLE_MARK } },
      () => assertSlotOwned(slot, this.owned),
      () => {
        if (typeof secretRef?.secretRef !== "string" || secretRef.secretRef.length === 0) {
          throw new HostError("Refused", "a secret handle is required");
        }
        this.stateOf(slot).credentials = { secretRef: secretRef.secretRef };
        return { ok: true, detail: `credentials set for ${slotId(slot)}` };
      },
    );
  }

  baselineBuild(flavor: FlavorKey): Promise<BaselineBuildResult> {
    return this.call<BaselineBuildResult>(
      "baselineBuild",
      { flavor },
      () => assertFlavorOwned(flavor, this.owned),
      () => {
        this.baselines.add(flavor);
        return { ok: true, detail: `built the ${flavor} baseline`, goldenHash: fakeGoldenHash(flavor) };
      },
    );
  }

  baselineVerify(flavor: FlavorKey, options: BaselineVerifyOptions = {}): Promise<BaselineVerifyResult> {
    const level = options.level ?? "golden";
    return this.call<BaselineVerifyResult>(
      "baselineVerify",
      { flavor, args: { level } },
      () => {
        assertFlavorOwned(flavor, this.owned);
        if (!(VERIFY_LEVELS as readonly string[]).includes(level)) {
          throw new HostError("Refused", `unknown verify level "${String(level)}"`);
        }
      },
      () => {
        const built = this.baselines.has(flavor);
        return {
          ok: built,
          level,
          detail: built ? `the ${flavor} baseline verifies (${level})` : `the ${flavor} baseline is not built`,
          ...(built ? { goldenHash: this.golden(flavor).hash } : {}),
        };
      },
    );
  }

  // ---- internals -------------------------------------------------------------------------------

  private stampOf(slot: SlotRef, goldenHash: string): SlotStamp {
    return {
      slotId: slotId(slot),
      flavor: slot.flavor,
      goldenHash,
      lastResetAt: new Date(this.clock.now()).toISOString(),
      leaseId: null,
    };
  }

  private stateOf(slot: SlotRef): FakeSlotState {
    const state = this.slots.get(slotId(slot));
    if (!state) throw new HostError("Refused", `slot ${slotId(slot)} is not provisioned`);
    return state;
  }

  private assertSameFlavor(slot: SlotRef, flavor: FlavorKey): void {
    if (!isFlavorKey(flavor) || flavor !== slot.flavor) {
      throw new HostError("Refused", `a ${String(flavor)} reference cannot be applied to a ${slot.flavor} slot`);
    }
  }

  /** The fault that applies to this call, if any. Counts the call against every matching fault. */
  private faultFor(method: HostMethod, slot: SlotRef | undefined): Fault | undefined {
    let hit: Fault | undefined;
    for (const active of this.faults) {
      const f = active.fault;
      if (f.method !== method) continue;
      if (f.slot && (!slot || slotId(f.slot) !== slotId(slot))) continue;
      active.seen += 1;
      const nth = f.nth ?? 1;
      const times = f.times ?? 1;
      if (!hit && active.seen >= nth && active.seen < nth + times) hit = f;
    }
    return hit;
  }

  /**
   * Every call goes through here: record it, run the guards, check the host is reachable, apply a
   * fault, charge the latency, then run the effect and stamp the elapsed time on the result.
   */
  private async call<T extends HostResult>(
    method: HostMethod,
    target: CallTarget,
    guard: () => void,
    effect: () => Omit<T, "ms">,
  ): Promise<T> {
    const start = this.clock.now();
    const entry: CallRecord = {
      seq: this.record.length + 1,
      method,
      target: targetLabel(target),
      args: target.args ?? {},
      at: start,
      outcome: "hung",
      ms: 0,
    };
    this.record.push(entry);
    try {
      guarded(guard);
      if (!this.reachable) throw new HostError("Unreachable", "the host did not answer");
      const fault = this.faultFor(method, target.slot);
      if (fault?.kind === "fail") {
        throw new HostError(fault.error ?? "Retryable", fault.message ?? `injected failure in ${method}`);
      }
      if (fault?.kind === "slow") this.clock.advance(fault.ms);
      if (fault?.kind === "hang") await new Promise<void>((release) => this.hangs.push(release));
      this.clock.advance(this.latencyMs);
      const result = effect();
      entry.ms = this.clock.now() - start;
      entry.outcome = result.ok ? "ok" : "not-ok";
      return { ...result, ms: entry.ms } as T;
    } catch (err) {
      entry.ms = this.clock.now() - start;
      entry.outcome = "error";
      if (err instanceof HostError) entry.error = err.kind;
      throw err;
    }
  }
}
