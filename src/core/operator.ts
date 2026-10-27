// The operator commands (ticket 16): what a person, or firstmate, uses when something is wrong.
// `doctor`, `repair`, `destroy`, `prune`, `force-return`, `disable` and `enable`, over the state store
// and the host driver, tested against `FakeHost`.
//
// - Every destructive command is a dry run unless `yes`: it says what it would do and changes nothing.
// - A command names a slot only by its id (`<flavor>-<NN>`); a deny-listed name is refused (exit 7)
//   before the state or the host is read. `doctor` and `prune` act only on what the host lists as
//   the tool's own slots (`listSlots`), and only after the listed slot parses back to a slot id.
// - There is no lease expiry (the captain's answer 5): nothing here reclaims a lease by age.
//   `force-return` is the operator's explicit `return`, and needs the lease as `status` shows it.

import type { HostDriver, ListedSlot } from "../host/driver.js";
import { isHostError } from "../host/errors.js";
import { type ArashouseConfig, DEFAULT_CONFIG } from "./config.js";
import { EXIT_CODES } from "./exit-codes.js";
import { FLAVOR_KEYS, type FlavorKey } from "./flavors.js";
import { GuardError, assertOwned, nameDenial } from "./guards.js";
import { type ResetWorkerAlive, checkDiskForBuild, isResetWorkerAlive, runningResets } from "./governor.js";
import {
  GuardRefusedError,
  LeaseError,
  LeaseMismatchError,
  OLD_LEASE_SECONDS,
  UsageError,
  asLeaseError,
  checkClean,
  exitCodeFor,
  formatAge,
  leaseRef,
  leaseSecretName,
} from "./lease.js";
import { licenceStatus } from "./licence.js";
import { type SlotRef, parseSlotId, slotId, slotNames, slotNumber } from "./names.js";
import { rebuildState } from "./recovery.js";
import { redact } from "./redact.js";
import { type ResetDeps, type ResetHost, describeOutcome, recoverDeadResets, resetSlot } from "./reset.js";
import { type SetupObservation, checkSetup } from "./setup-host.js";
import type { SecretStore } from "./secret-store.js";
import { type Lease, RECOVERED_HOLDER, type Slot, type State, StateCorruptError, isLeaseId } from "./state.js";
import type { StateStore } from "./store.js";

/** The host calls the operator commands make. */
export type OperatorHost = ResetHost &
  Pick<HostDriver, "ping" | "hostInfo" | "listSlots" | "provisionSlot" | "destroySlot" | "stopSlot" | "baselineVerify">;

export interface OperatorDeps {
  readonly store: StateStore;
  readonly host: OperatorHost;
  /** The lease passwords (`LeaseFileStore` in the CLI): a forced return or a destroy deletes the lease's. */
  readonly secrets: SecretStore;
  /** The reset sequence `repair` runs (reset.ts); its `config` is the pool's limits. */
  readonly reset: ResetDeps;
  /** Starts a detached reset worker for a slot just marked dirty. Best effort: a lazy reset in `get` covers a failure. */
  readonly startWorker?: (slot: string) => void;
  /** Whether the flavor's media is present (`flavors`' check); null when its folder cannot be found. Absent: `doctor` skips media. */
  readonly media?: (flavor: FlavorKey) => Promise<boolean | null>;
  /** The host's licence-key store (tickets 20 and 21); `doctor` reports each line's key as present or absent. Absent: skipped. */
  readonly licences?: SecretStore;
  /** What the worker sees of `arashouse setup` on the host (ticket 21). Absent: `doctor` skips the setup checks. */
  readonly setup?: () => Promise<SetupObservation>;
  readonly now?: () => Date;
}

/** What an operator command did: the lines to print and the exit code. */
export interface OperatorResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
  /** `doctor` only: its checks, for `doctor --json`. */
  readonly findings?: readonly Finding[];
}

export const DRY_RUN = "dry run: nothing was changed; run again with --yes to do it";

/** Room for a prefix in a quarantine reason (state.ts allows 500 characters). */
const MAX_REASON = 480;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 3)}...` : text;
}

function poolConfig(deps: OperatorDeps): ArashouseConfig {
  return deps.reset.config ?? DEFAULT_CONFIG;
}

function workerAlive(deps: OperatorDeps): ResetWorkerAlive {
  return deps.reset.isWorkerAlive ?? isResetWorkerAlive;
}

function startWorker(deps: OperatorDeps, slot: string): void {
  try {
    deps.startWorker?.(slot);
  } catch {
    // A slot left dirty is reset by the next worker or lazily by `get`.
  }
}

function refOf(slot: Slot): SlotRef {
  return { flavor: slot.flavor, slot: slot.number };
}

function sortedSlots(state: State): Slot[] {
  return Object.values(state.slots).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- naming a slot -------------------------------------------------------------------------------

/** Why `text` names something on the deny-list (a name, or a path of the captain's installs), or undefined. */
function denial(text: string): string | undefined {
  const byName = nameDenial(text);
  if (byName) return byName;
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    try {
      assertOwned("path", text);
    } catch (err) {
      if (err instanceof GuardError && err.code === "denied") return "a deny-listed path";
    }
  }
  return undefined;
}

/**
 * The slot an operator command names. A deny-listed name is refused (exit 7) and anything that is
 * not a slot id is a usage error (exit 2), both before the state or the host is read.
 */
export function operatorSlot(arg: unknown): SlotRef {
  const text = typeof arg === "string" ? arg : "";
  const why = denial(text);
  if (why) throw new GuardRefusedError(`refused "${text}": ${why}; arashouse acts only on its own slots`);
  try {
    return parseSlotId(text);
  } catch {
    throw new UsageError(`"${text}" is not a slot id (<flavor>-<NN>)`);
  }
}

interface HostSlots {
  /** The host's slots by id, each rebuilt from its id so nothing the host sent is passed back. */
  readonly slots: ReadonlyMap<string, ListedSlot>;
  /** Entries that are not a slot of a registered flavor, or repeat one: never acted on. */
  readonly ignored: number;
}

async function hostSlots(host: Pick<HostDriver, "listSlots">): Promise<HostSlots> {
  const slots = new Map<string, ListedSlot>();
  let ignored = 0;
  for (const listed of (await host.listSlots()).slots) {
    let ref: SlotRef;
    try {
      ref = parseSlotId(slotId(listed.slot));
    } catch {
      ignored++;
      continue;
    }
    const id = slotId(ref);
    if (slots.has(id)) {
      ignored++;
      continue;
    }
    slots.set(id, { slot: ref, stamp: listed.stamp });
  }
  return { slots, ignored };
}

function ignoredLine(count: number): string {
  return `ignored ${count} entr${count === 1 ? "y" : "ies"} the host listed that ${count === 1 ? "is not an arashouse slot" : "are not arashouse slots"}`;
}

// ---- force-return --------------------------------------------------------------------------------

export interface ForceReturnRequest {
  readonly slot: string;
  /** The lease as `status` shows it (its 8-character reference), or the whole lease id. */
  readonly leaseId: string | undefined;
  readonly yes: boolean;
}

const LEASE_REF = /^[0-9a-f]{8}$/;

function sameLease(lease: Lease, given: string): boolean {
  return given.length === lease.lease_id.length ? lease.lease_id === given : leaseRef(lease.lease_id) === given;
}

type ForceDecision = { readonly kind: "not-leased"; readonly status: Slot["status"] } | { readonly kind: "match"; readonly lease: Lease };

/**
 * The operator's `return`, for a holder that crashed. It needs the lease the slot holds now, so it
 * cannot hit a later lease of the same slot: a different one exits 4 and changes nothing. It dirties
 * the slot like `return` and starts a reset worker.
 */
export async function forceReturn(deps: OperatorDeps, request: ForceReturnRequest): Promise<OperatorResult> {
  const id = slotId(operatorSlot(request.slot));
  const given = request.leaseId;
  if (given === undefined) throw new UsageError("force-return needs --lease-id <lease>: the LEASE column of `arashouse status`");
  if (!LEASE_REF.test(given) && !isLeaseId(given)) {
    throw new UsageError("--lease-id must be the lease as `arashouse status` shows it (8 hex characters) or the whole lease id");
  }
  const decide = (slot: Slot | undefined): ForceDecision => {
    if (!slot) throw new UsageError(`no slot "${id}" in the pool`);
    if (slot.status !== "leased" || !slot.lease) return { kind: "not-leased", status: slot.status };
    if (!sameLease(slot.lease, given)) throw new LeaseMismatchError(id);
    return { kind: "match", lease: slot.lease };
  };
  const notLeased = (status: Slot["status"]): OperatorResult => ({ exitCode: EXIT_CODES.ok, lines: [`${id} is ${status}, not leased: nothing to return`] });

  if (!request.yes) {
    const decision = decide((await deps.store.read()).slots[id]);
    if (decision.kind === "not-leased") return notLeased(decision.status);
    const { lease } = decision;
    return {
      exitCode: EXIT_CODES.ok,
      lines: [`would force-return ${id}: lease ${leaseRef(lease.lease_id)}, held by ${lease.holder} since ${lease.leased_at}; the slot is discarded and reset`, DRY_RUN],
    };
  }
  const decision = await deps.store.update((tx) => {
    const d = decide(tx.slot(id));
    if (d.kind === "match") tx.transition(id, { to: "dirty" }, "force-returned by the operator");
    return d;
  });
  if (decision.kind === "not-leased") return notLeased(decision.status);
  await deps.secrets.delete(leaseSecretName(decision.lease.lease_id)).catch(() => undefined);
  startWorker(deps, id);
  return {
    exitCode: EXIT_CODES.ok,
    lines: [`force-returned ${id} (lease ${leaseRef(decision.lease.lease_id)}, held by ${decision.lease.holder}); it is reset before it is handed out again`],
  };
}

// ---- disable and enable --------------------------------------------------------------------------

/**
 * Takes a slot out of rotation and stops it on the host (to give its RAM back). A leased slot is
 * refused (return or force-return it first), and so is one being reset.
 */
export async function disableSlot(deps: OperatorDeps, slotArg: string): Promise<OperatorResult> {
  const ref = operatorSlot(slotArg);
  const id = slotId(ref);
  const was = await deps.store.update((tx) => {
    const slot = tx.slot(id);
    if (!slot) throw new UsageError(`no slot "${id}" in the pool`);
    if (slot.status === "disabled") return null;
    if (slot.status === "leased") throw new GuardRefusedError(`${id} is leased to ${slot.lease?.holder ?? "?"}; disable it once it is returned`);
    if (slot.status === "resetting") throw new GuardRefusedError(`${id} is being reset; disable it when the reset has ended`);
    tx.transition(id, { to: "disabled" }, "disabled by the operator");
    return slot.status;
  });
  if (was === null) return { exitCode: EXIT_CODES.ok, lines: [`${id} is already disabled`] };
  const lines = [`disabled ${id} (it was ${was}); it is not handed out until \`arashouse enable ${id}\``];
  try {
    await deps.host.stopSlot(ref);
    lines.push(`stopped ${id}: its applications are offline`);
  } catch (err) {
    lines.push(`${id} could not be stopped (${redact(errorText(err))}); it is out of rotation all the same`);
  }
  return { exitCode: EXIT_CODES.ok, lines };
}

/** Puts a disabled slot back in rotation: it goes to `dirty`, so it is reset before it is handed out. */
export async function enableSlot(deps: OperatorDeps, slotArg: string): Promise<OperatorResult> {
  const id = slotId(operatorSlot(slotArg));
  const was = await deps.store.update((tx) => {
    const slot = tx.slot(id);
    if (!slot) throw new UsageError(`no slot "${id}" in the pool`);
    if (slot.status !== "disabled") return slot.status;
    tx.transition(id, { to: "dirty" }, "enabled by the operator");
    return null;
  });
  if (was !== null) return { exitCode: EXIT_CODES.ok, lines: [`${id} is ${was}, not disabled: nothing to do`] };
  startWorker(deps, id);
  return { exitCode: EXIT_CODES.ok, lines: [`enabled ${id}: it is reset before it is handed out`] };
}

// ---- destroy and prune ---------------------------------------------------------------------------

export interface DestroyRequest {
  readonly slot: string;
  readonly yes: boolean;
  /** Also destroy a leased slot; its lease is lost. Only with the slot named exactly. */
  readonly includeLeased?: boolean;
}

/** What `destroySlot` on the host removes, by name. */
function removalSummary(ref: SlotRef): string {
  const n = slotNames(ref);
  return [
    `application ${n.alias}`,
    `app pools ${Object.values(n.appPools).join(", ")}`,
    `service ${n.service}`,
    `database ${n.database} and its logins`,
    `folders slots\\${ref.flavor}\\${slotNumber(ref.slot)} and vaults\\${slotId(ref)}`,
  ].join(", ");
}

interface DestroyOptions {
  readonly yes: boolean;
  readonly includeLeased: boolean;
  /** For `prune` and `doctor --fix`: destroy only while the slot is still disabled, or still has no record. */
  readonly only?: "disabled" | "orphan";
}

/** Destroys one slot, whose host entry (if any) the caller listed just before. */
async function destroyOne(deps: OperatorDeps, ref: SlotRef, onHost: ListedSlot | undefined, options: DestroyOptions): Promise<OperatorResult> {
  const id = slotId(ref);
  const alive = workerAlive(deps);
  /** Why the slot is skipped (prune and doctor only), or undefined; throws when the slot must not be destroyed. */
  const check = (slot: Slot | undefined): string | undefined => {
    if (options.only === "disabled" && slot?.status !== "disabled") return `${id} is no longer disabled`;
    if (options.only === "orphan" && slot) return `${id} has a slot record now`;
    if (!slot && !onHost) throw new UsageError(`no slot "${id}" in the pool or on the host`);
    const holder = slot ? (slot.status === "leased" ? (slot.lease?.holder ?? "?") : null) : onHost?.stamp?.leaseId ? RECOVERED_HOLDER : null;
    if (holder !== null && !options.includeLeased) {
      throw new GuardRefusedError(`${id} is leased (to ${holder}); destroy refuses a leased slot unless --include-leased is given with its exact name`);
    }
    if (slot?.status === "resetting" && slot.reset && alive(slot.reset.pid, slot.reset.start_time ?? null)) {
      throw new GuardRefusedError(`${id} is being reset by pid ${slot.reset.pid}; destroy it when the reset has ended`);
    }
    return undefined;
  };

  if (!options.yes) {
    const slot = (await deps.store.read()).slots[id];
    const skip = check(slot);
    if (skip) return { exitCode: EXIT_CODES.ok, lines: [`skipped ${skip}`] };
    const where = [slot ? `its record (${slot.status})` : null, onHost ? removalSummary(ref) : null].filter(Boolean).join("; ");
    return { exitCode: EXIT_CODES.ok, lines: [`would destroy ${id}: ${where}`] };
  }

  const removed = await deps.store.update((tx) => {
    const slot = tx.slot(id);
    const skip = check(slot);
    if (skip) return { skip } as const;
    if (slot) tx.removeSlot(id, "destroyed by the operator");
    return { slot } as const;
  });
  if ("skip" in removed) return { exitCode: EXIT_CODES.ok, lines: [`skipped ${removed.skip}`] };
  const lease = removed.slot?.lease;
  if (lease) await deps.secrets.delete(leaseSecretName(lease.lease_id)).catch(() => undefined);
  if (!onHost) return { exitCode: EXIT_CODES.ok, lines: [`removed the record of ${id}; it was not on the host`] };
  try {
    await deps.host.destroySlot(ref);
  } catch (err) {
    const mapped = asLeaseError(err);
    const why = redact(errorText(mapped));
    throw new LeaseError(
      exitCodeFor(err) as LeaseError["exitCode"],
      `${removed.slot ? `removed the record of ${id}, but ` : ""}the host did not destroy it (${why}); it is left as an orphan that \`arashouse destroy ${id} --yes\` removes`,
      { cause: err },
    );
  }
  return { exitCode: EXIT_CODES.ok, lines: [`destroyed ${id}: ${removalSummary(ref)}${removed.slot ? `; its record (${removed.slot.status}) is gone` : ""}`] };
}

/**
 * Removes a slot's application, pools, service, folders and database through the host, and its
 * record. A leased slot is refused unless `includeLeased`; so is one whose reset is running.
 */
export async function destroySlot(deps: OperatorDeps, request: DestroyRequest): Promise<OperatorResult> {
  const ref = operatorSlot(request.slot);
  const listed = await hostSlots(deps.host);
  const result = await destroyOne(deps, ref, listed.slots.get(slotId(ref)), { yes: request.yes, includeLeased: request.includeLeased === true });
  return request.yes ? result : { ...result, lines: [...result.lines, DRY_RUN] };
}

/**
 * Lists, and with `yes` destroys, the slots that are `disabled` and the orphans (on the host with no
 * record). Not by age: there is no lease expiry. An orphan whose stamp names a lease is left alone.
 */
export async function prune(deps: OperatorDeps, request: { readonly yes: boolean }): Promise<OperatorResult> {
  const state = await deps.store.read();
  const listed = await hostSlots(deps.host);
  const targets: { ref: SlotRef; onHost: ListedSlot | undefined; only: "disabled" | "orphan" }[] = [];
  const notes: string[] = [];
  for (const slot of sortedSlots(state)) {
    if (slot.status === "disabled") targets.push({ ref: refOf(slot), onHost: listed.slots.get(slot.id), only: "disabled" });
  }
  for (const [id, entry] of listed.slots) {
    if (state.slots[id]) continue;
    if (entry.stamp?.leaseId) {
      notes.push(`left orphan ${id}: its stamp names a lease (\`arashouse doctor --rebuild-state --yes\` recovers it; \`arashouse destroy ${id} --include-leased --yes\` removes it)`);
      continue;
    }
    targets.push({ ref: entry.slot, onHost: entry, only: "orphan" });
  }
  if (listed.ignored > 0) notes.push(ignoredLine(listed.ignored));
  if (targets.length === 0) return { exitCode: EXIT_CODES.ok, lines: ["nothing to prune: no disabled or orphaned slot", ...notes] };

  const lines: string[] = [];
  let exitCode: number = EXIT_CODES.ok;
  for (const t of targets) {
    const why = t.only === "disabled" ? "disabled" : "orphaned: on the host with no slot record";
    if (!request.yes) {
      lines.push(`would destroy ${slotId(t.ref)} (${why})`);
      continue;
    }
    try {
      lines.push(...(await destroyOne(deps, t.ref, t.onHost, { yes: true, includeLeased: false, only: t.only })).lines);
    } catch (err) {
      if (exitCode === EXIT_CODES.ok) exitCode = exitCodeFor(err);
      lines.push(`${slotId(t.ref)} not destroyed: ${redact(errorText(asLeaseError(err)))}`);
    }
  }
  return { exitCode, lines: [...lines, ...notes, ...(request.yes ? [] : [DRY_RUN])] };
}

// ---- repair --------------------------------------------------------------------------------------

export interface RepairRequest {
  readonly slot: string;
  /** Also recreate the slot's IIS application and database shell (destroy and provision it) first. */
  readonly rebuild?: boolean;
}

/**
 * The way out of `quarantined`: re-provisions the slot from golden and resets it, with the same
 * reset sequence the worker runs (database and tree from golden, start, health). `rebuild` first
 * destroys and provisions the slot on the host (ticket 25), behind the disk gate.
 */
export async function repairSlot(deps: OperatorDeps, request: RepairRequest): Promise<OperatorResult> {
  const ref = operatorSlot(request.slot);
  const id = slotId(ref);
  const quarantined = (slot: Slot | undefined): void => {
    if (!slot) throw new UsageError(`no slot "${id}" in the pool`);
    if (slot.status !== "quarantined") throw new GuardRefusedError(`${id} is ${slot.status}, not quarantined: repair is the way out of quarantined`);
  };
  const lines: string[] = [];
  if (request.rebuild === true) {
    quarantined((await deps.store.read()).slots[id]);
    const disk = await checkDiskForBuild(deps.host, poolConfig(deps));
    if (!disk.ok) throw new GuardRefusedError(`repair --rebuild of ${id} cannot start: ${disk.reason}`);
    await deps.store.update((tx) => {
      quarantined(tx.slot(id));
      tx.transition(id, { to: "provisioning" }, "repair --rebuild");
    });
    try {
      if ((await hostSlots(deps.host)).slots.has(id)) await deps.host.destroySlot(ref);
      await deps.host.provisionSlot(ref);
    } catch (err) {
      const reason = clip(redact(`repair --rebuild failed: ${errorText(err)}`));
      await deps.store
        .update((tx) => {
          if (tx.slot(id)?.status === "provisioning") tx.transition(id, { to: "quarantined", reason });
        })
        .catch(() => undefined);
      throw asLeaseError(err);
    }
    await deps.store.update((tx) => {
      const slot = tx.slot(id);
      if (slot?.status !== "provisioning") throw new Error(`${id} was moved to ${slot?.status ?? "nothing"} by another process during its rebuild`);
      tx.transition(id, { to: "dirty" }, "rebuilt by repair; reset before use");
    });
    lines.push(`rebuilt ${id}: ${removalSummary(ref)} recreated from the ${ref.flavor} templates`);
  } else {
    await deps.store.update((tx) => {
      quarantined(tx.slot(id));
      tx.transition(id, { to: "dirty" }, "repair");
    });
  }

  const outcome = await resetSlot(deps.reset, id);
  lines.push(describeOutcome(outcome));
  switch (outcome.kind) {
    case "free":
      return { exitCode: EXIT_CODES.ok, lines: [...lines, `repaired ${id}`] };
    case "quarantined":
      return { exitCode: EXIT_CODES.resetFailed, lines };
    case "dirty":
      return { exitCode: EXIT_CODES.hostUnreachable, lines };
    case "not-started":
      startWorker(deps, id);
      return { exitCode: EXIT_CODES.ok, lines: [...lines, `${id} is dirty; a reset worker resets it when a reset place is free`] };
    case "lost":
      return { exitCode: EXIT_CODES.ok, lines };
  }
}

// ---- doctor --------------------------------------------------------------------------------------

export interface DoctorRequest {
  /** Re-start resets that stalled, mark a free slot that is not clean dirty, and (with `yes`) remove orphans. */
  readonly fix?: boolean;
  /** Rebuild the state from the slot stamps (ticket 11's recovery); a dry run without `yes`. */
  readonly rebuildState?: boolean;
  /** Verify each baseline at the full level (every file's SHA-256, `docs/manifest.md`) instead of fast. */
  readonly deep?: boolean;
  readonly yes?: boolean;
}

export type FindingLevel = "ok" | "warn" | "fail";

export interface Finding {
  readonly level: FindingLevel;
  readonly check: string;
  readonly message: string;
  /** What `--fix` did, or would do with `--yes`. */
  fixed?: string;
  /** True when `fixed` says the problem is dealt with. */
  resolved?: boolean;
}

/** A check's line, and the line of its fix under it. */
export function formatFindings(findings: readonly Finding[]): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${f.level.padEnd(4)}  ${f.check}: ${f.message}`);
    if (f.fixed !== undefined) lines.push(`      ${f.resolved ? "fixed" : "not fixed"}: ${f.fixed}`);
  }
  const open = findings.filter((f) => f.level === "fail" && !f.resolved).length;
  const fixed = findings.filter((f) => f.resolved).length;
  const warned = findings.filter((f) => f.level === "warn").length;
  lines.push(open === 0 && warned === 0 ? `doctor: every check passed${fixed > 0 ? ` (${fixed} fixed)` : ""}` : `doctor: ${open} problem${open === 1 ? "" : "s"}, ${warned} warning${warned === 1 ? "" : "s"}${fixed > 0 ? `, ${fixed} fixed` : ""}`);
  return lines;
}

/**
 * Checks the pool: the state file, the host setup (ticket 21), the broker, the SQL login, free disk and RAM, the media and
 * baselines, every slot record against the host's stamps, slots with no record (orphans), and resets
 * with no live worker. It reads only the tool's own slots, as the host lists them. Exit 1 when a
 * check fails and was not fixed, else 0.
 */
export async function doctor(deps: OperatorDeps, request: DoctorRequest = {}): Promise<OperatorResult> {
  const findings: Finding[] = [];
  const add = (level: FindingLevel, check: string, message: string): Finding => {
    const finding: Finding = { level, check, message: redact(message) };
    findings.push(finding);
    return finding;
  };
  const done = (): OperatorResult => ({
    exitCode: findings.some((f) => f.level === "fail" && !f.resolved) ? 1 : EXIT_CODES.ok,
    lines: formatFindings(findings),
    findings,
  });
  const now = (deps.now ?? (() => new Date()))();
  const config = poolConfig(deps);
  const { host } = deps;

  let state: State | null = null;
  try {
    state = await deps.store.read();
    add("ok", "state", `${Object.keys(state.slots).length} slots, revision ${state.revision}`);
  } catch (err) {
    if (!(err instanceof StateCorruptError)) throw err;
    add("fail", "state", err.message);
  }

  if (deps.setup) {
    for (const f of checkSetup(await deps.setup())) add(f.level, f.check, f.message);
  }

  try {
    add("ok", "broker", `answers (${(await host.ping()).detail})`);
  } catch (err) {
    if (!isHostError(err)) throw err;
    add("fail", "broker", `did not answer: ${errorText(err)}; the host checks were skipped`);
    return done();
  }

  try {
    const { info } = await host.hostInfo();
    if (info.sqlReachable) add("ok", "sql", "the broker's SQL login connects");
    else add("fail", "sql", "the broker cannot connect to SQL Server with its login");
    if (info.freeDiskGb >= config.min_free_disk_gb) add("ok", "disk", `${info.freeDiskGb} GB free at the install root`);
    else add("warn", "disk", `${info.freeDiskGb} GB free at the install root, under min_free_disk_gb ${config.min_free_disk_gb}: no provision or baseline build starts`);
    if (info.freeRamMb >= config.min_free_ram_mb) add("ok", "ram", `${info.freeRamMb} MB free`);
    else add("warn", "ram", `${info.freeRamMb} MB free, under min_free_ram_mb ${config.min_free_ram_mb}: get hands out no slot`);
  } catch (err) {
    if (!isHostError(err)) throw err;
    add("fail", "host", `hostInfo failed: ${errorText(err)}`);
  }

  for (const flavor of FLAVOR_KEYS) {
    const inPool = state !== null && Object.values(state.slots).some((s) => s.flavor === flavor);
    if (deps.media) {
      const present = await deps.media(flavor).catch(() => null);
      if (present === true) add("ok", `media ${flavor}`, "present");
      else add("warn", `media ${flavor}`, present === false ? "missing or incomplete (`arashouse media check`)" : "the media folder cannot be found");
    }
    try {
      const verified = await host.baselineVerify(flavor, { level: request.deep === true ? "full" : "fast" });
      if (verified.ok) add("ok", `baseline ${flavor}`, verified.detail);
      else add(inPool ? "fail" : "warn", `baseline ${flavor}`, `${verified.detail}${inPool ? ": its slots cannot be reset" : ""}`);
    } catch (err) {
      if (!isHostError(err)) throw err;
      add(inPool ? "fail" : "warn", `baseline ${flavor}`, `could not be verified: ${errorText(err)}`);
    }
  }

  if (deps.licences) {
    for (const status of await licenceStatus(deps.licences)) {
      add("ok", `licence line ${status.line}`, status.present ? "present" : "absent (asked for when a step needs it)");
    }
  }

  let listed: HostSlots;
  try {
    listed = await hostSlots(host);
  } catch (err) {
    if (!isHostError(err)) throw err;
    add("fail", "slots", `the host could not list its slots: ${errorText(err)}`);
    return done();
  }
  if (listed.ignored > 0) add("warn", "host", ignoredLine(listed.ignored));

  if (request.rebuildState === true) {
    const stamps = [...listed.slots.values()].flatMap((l) => (l.stamp ? [l.stamp] : []));
    const unstamped = [...listed.slots.keys()].filter((id) => !listed.slots.get(id)?.stamp);
    const rebuilt = rebuildState(stamps, now);
    const summary = rebuilt.slots.map((e) => `${e.slot} ${e.status}`).join(", ") || "no slots";
    const lost = [...rebuilt.skipped.map((s) => `${s.slotId} (${s.reason})`), ...unstamped.map((id) => `${id} (no stamp)`)];
    const tail = lost.length > 0 ? `; left out: ${lost.join(", ")}` : "";
    if (request.yes === true) {
      state = await deps.store.replace(rebuilt.state, "doctor --rebuild-state");
      const f = add("ok", "state", `rebuilt from ${stamps.length} slot stamps: ${summary}${tail}`);
      f.fixed = "the old file was set aside as state.json.corrupt-<time>";
      f.resolved = true;
      for (const prior of findings) if (prior.check === "state" && prior.level === "fail") prior.resolved = true;
    } else {
      const f = add("warn", "state", `--rebuild-state would replace the state with ${rebuilt.slots.length} slots from the stamps: ${summary}${tail}`);
      f.fixed = DRY_RUN;
    }
  }

  if (state === null) {
    add("fail", "slots", "skipped: the state file is unusable; `arashouse doctor --rebuild-state --yes` rebuilds it from the slot stamps");
    return done();
  }

  const fix = request.fix === true;
  const alive = workerAlive(deps);
  const running = runningResets(Object.values(state.slots), alive).length;
  for (const slot of sortedSlots(state)) {
    const check = `slot ${slot.id}`;
    const onHost = listed.slots.get(slot.id);
    if (!onHost) {
      if (slot.status === "provisioning") add("warn", check, "provisioning, and not on the host yet");
      else add("fail", check, `${slot.status} in the state but not on the host (\`arashouse destroy ${slot.id} --yes\` drops the record)`);
      continue;
    }
    const stamp = onHost.stamp;
    if (stamp && (stamp.slotId !== slot.id || stamp.flavor !== slot.flavor)) {
      add("fail", check, `its stamp belongs to ${stamp.slotId} (${stamp.flavor})`);
      continue;
    }
    switch (slot.status) {
      case "free": {
        let verdict;
        try {
          verdict = await checkClean(host, slot);
        } catch (err) {
          if (!isHostError(err)) throw err;
          add("warn", check, `free, but could not be checked: ${errorText(err)}`);
          break;
        }
        if (verdict.clean) {
          add("ok", check, "free and clean");
          break;
        }
        const f = add("fail", check, `free in the state but not clean on the host: ${verdict.reason}`);
        if (fix) {
          const moved = await deps.store.update((tx) => {
            const current = tx.slot(slot.id);
            if (current?.status !== "free" || current.last_reset_at !== slot.last_reset_at) return false;
            tx.transition(slot.id, { to: "dirty" }, `doctor: ${clip(verdict.reason)}`);
            return true;
          });
          if (moved) startWorker(deps, slot.id);
          f.fixed = moved ? "marked dirty; a reset worker resets it" : "it moved on before it could be marked dirty";
          f.resolved = true;
        }
        break;
      }
      case "leased": {
        const lease = slot.lease as Lease;
        if (stamp?.leaseId !== lease.lease_id) add("warn", check, `leased, but its stamp names ${stamp?.leaseId ? "another lease" : "no lease"}`);
        const age = Math.max(0, Math.floor((now.getTime() - Date.parse(lease.leased_at)) / 1000));
        if (age >= OLD_LEASE_SECONDS) {
          add("warn", check, `leased to ${lease.holder} for ${formatAge(age)} (old): nothing reclaims it; if its holder is gone, \`arashouse force-return ${slot.id} --lease-id ${leaseRef(lease.lease_id)} --yes\``);
        } else {
          add("ok", check, `leased to ${lease.holder} for ${formatAge(age)}`);
        }
        break;
      }
      case "dirty": {
        if (running > 0) {
          add("ok", check, "dirty; a running reset worker resets it");
          break;
        }
        const f = add("warn", check, "dirty, and no reset is running (the next `get` resets it lazily)");
        if (fix) {
          startWorker(deps, slot.id);
          f.fixed = "started a reset worker";
          f.resolved = true;
        }
        break;
      }
      case "resetting": {
        const reset = slot.reset;
        if (reset && alive(reset.pid, reset.start_time ?? null)) {
          add("ok", check, `resetting (pid ${reset.pid}, attempt ${reset.attempt})`);
          break;
        }
        const f = add("fail", check, `resetting, but its reset worker${reset ? ` (pid ${reset.pid})` : ""} has ended`);
        if (fix) {
          const moved = await recoverDeadResets(deps.store, alive);
          if (moved.includes(slot.id)) startWorker(deps, slot.id);
          f.fixed = moved.includes(slot.id) ? "sent back to dirty; a reset worker resets it" : "it moved on before it could be recovered";
          f.resolved = true;
        }
        break;
      }
      case "quarantined":
        add("warn", check, `quarantined: ${slot.quarantine_reason ?? "?"} (\`arashouse repair ${slot.id}\`)`);
        break;
      case "disabled":
        add("ok", check, `disabled (\`arashouse enable ${slot.id}\` puts it back; \`arashouse prune --yes\` destroys it)`);
        break;
      case "provisioning":
        add("warn", check, "provisioning");
        break;
    }
  }

  for (const [id, entry] of listed.slots) {
    if (state.slots[id]) continue;
    if (entry.stamp?.leaseId) {
      add("fail", `orphan ${id}`, "on the host with no slot record, and its stamp names a lease (`arashouse doctor --rebuild-state --yes` recovers it)");
      continue;
    }
    const f = add("fail", `orphan ${id}`, "on the host with no slot record (`arashouse prune --yes` removes it)");
    if (!fix) continue;
    if (request.yes !== true) {
      f.fixed = `would destroy ${id}; add --yes`;
      continue;
    }
    try {
      const result = await destroyOne(deps, entry.slot, entry, { yes: true, includeLeased: false, only: "orphan" });
      f.fixed = result.lines.join("; ");
      f.resolved = true;
    } catch (err) {
      f.fixed = `destroy failed: ${redact(errorText(asLeaseError(err)))}`;
    }
  }
  return done();
}
