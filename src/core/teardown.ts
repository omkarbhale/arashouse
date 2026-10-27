// `arashouse teardown` (ticket 49), the WSL half: the whole pool goes, as safely as one slot's reset.
// It destroys every slot (the state's and the orphans the host lists) through the broker's
// `destroySlot`, as `destroy` does one, and says what the elevated half, `teardown.ps1`
// (src/broker/teardown-script.ts), then removes: the goldens, the SQL objects, the broker and the
// root. A dry run unless `yes`. A leased slot is refused unless every leased slot is named exactly
// and `includeLeased` is given; a slot whose reset is running is refused. Both refusals come before
// anything is destroyed. docs/teardown.md describes the command.

import { EXIT_CODES } from "./exit-codes.js";
import { FLAVOR_KEYS } from "./flavors.js";
import { GuardRefusedError, UsageError, asLeaseError, exitCodeFor } from "./lease.js";
import { UTILITY_DATABASE, goldenDir, slotId, type SlotRef } from "./names.js";
import { type OperatorDeps, type OperatorResult, DRY_RUN, destroyOne, hostSlots, ignoredLine, operatorSlot, workerAlive } from "./operator.js";
import { redact } from "./redact.js";
import { POOL_LOGIN } from "./setup-sql.js";
import { RECOVERED_HOLDER } from "./state.js";

export interface TeardownRequest {
  readonly yes: boolean;
  /** Also destroy these leased slots (their leases are lost); every leased slot must be among them, named exactly. */
  readonly includeLeased?: readonly string[];
  /** The elevated half also removes `golden\<flavor>` for every flavor. */
  readonly goldens?: boolean;
  /** The elevated half leaves the SQL objects of `setup-sql` (ticket 22). */
  readonly keepSql?: boolean;
  /** The elevated half also removes the install root, if it holds only arashouse folders. Needs `goldens`; not with `keepSql`. */
  readonly removeRoot?: boolean;
}

export interface TeardownResult extends OperatorResult {
  /** Whether every slot is gone (or, in a dry run, would be): the elevated half refuses otherwise. */
  readonly slotsGone: boolean;
  /** The switches `teardown.ps1` takes for this request, besides `-Apply`. */
  readonly scriptSwitches: readonly string[];
}

/** The options the request's switches combine to, refused (exit 2) when they do not go together. */
export function teardownSwitches(request: Pick<TeardownRequest, "goldens" | "keepSql" | "removeRoot">): string[] {
  if (request.removeRoot && !request.goldens) throw new UsageError("--remove-root removes golden\\ too: give --goldens with it");
  if (request.removeRoot && request.keepSql) throw new UsageError("--remove-root removes sqldata\\, which holds arashouse_admin's files: it cannot go with --keep-sql");
  return [request.goldens ? "-Goldens" : "", request.keepSql ? "-KeepSql" : "", request.removeRoot ? "-RemoveRoot" : ""].filter(Boolean);
}

/** What `teardown.ps1` removes for these options, in its order, as lines for the plan. */
export function elevatedPlan(request: Pick<TeardownRequest, "goldens" | "keepSql" | "removeRoot">): string[] {
  const lines = ["then, elevated, teardown.ps1 (it refuses while any slot is left, and fingerprints the deny-list before and after):"];
  if (request.goldens) lines.push(`  remove the goldens: ${FLAVOR_KEYS.map((k) => goldenDir(k)).join(", ")}`);
  else lines.push("  keep the goldens (--goldens removes them)");
  if (request.keepSql) lines.push(`  keep ${UTILITY_DATABASE} and the broker's SQL login (--keep-sql)`);
  else lines.push(`  drop ${UTILITY_DATABASE} (its procedures, user and certificate), the certificate's login and the login [${POOL_LOGIN}] (setup-sql.ps1 -Uninstall)`);
  lines.push("  stop and delete the ArasHouseBroker service, take its account out of Administrators, remove the Defender exclusion if any (setup-host.ps1 -Uninstall)");
  if (request.removeRoot) lines.push("  remove the install root, if it holds only arashouse folders (setup-host.ps1 -RemoveRoot)");
  return lines;
}

interface Target {
  readonly ref: SlotRef;
  readonly id: string;
  /** The holder when the slot is leased (by its record, or by its stamp for an orphan), else null. */
  readonly holder: string | null;
}

/**
 * Destroys every slot of the pool, or (without `yes`) says what it would destroy, and what the elevated
 * half then removes. Throws, before anything is destroyed, on a leased slot not named in `includeLeased`,
 * on a name there that is not a leased slot, and on a slot whose reset is running. With `yes`,
 * `beforeDestroy` (the CLI writes the elevated bundle) runs once those checks pass and before the first
 * slot is destroyed, so when it fails nothing has changed.
 */
export async function teardownPool(deps: OperatorDeps, request: TeardownRequest, beforeDestroy?: () => Promise<void>): Promise<TeardownResult> {
  const scriptSwitches = teardownSwitches(request);
  const named = new Set((request.includeLeased ?? []).map((name) => slotId(operatorSlot(name))));
  const state = await deps.store.read();
  const listed = await hostSlots(deps.host);

  const targets: Target[] = [];
  for (const slot of Object.values(state.slots)) {
    targets.push({ ref: { flavor: slot.flavor, slot: slot.number }, id: slot.id, holder: slot.status === "leased" ? (slot.lease?.holder ?? "?") : null });
  }
  for (const [id, entry] of listed.slots) {
    if (!state.slots[id]) targets.push({ ref: entry.slot, id, holder: entry.stamp?.leaseId ? RECOVERED_HOLDER : null });
  }
  targets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const leased = targets.filter((t) => t.holder !== null);
  const unnamed = leased.filter((t) => !named.has(t.id));
  if (unnamed.length > 0) {
    throw new GuardRefusedError(
      `teardown refuses while slots are leased: ${unnamed.map((t) => `${t.id} (to ${t.holder})`).join(", ")}; return them first, or name each with --include-leased (its lease is lost)`,
    );
  }
  const notLeased = [...named].filter((id) => !leased.some((t) => t.id === id));
  if (notLeased.length > 0) throw new UsageError(`--include-leased names ${notLeased.join(", ")}, which ${notLeased.length === 1 ? "is not a leased slot" : "are not leased slots"} of the pool`);
  const alive = workerAlive(deps);
  const resetting = Object.values(state.slots).filter((s) => s.status === "resetting" && s.reset && alive(s.reset.pid, s.reset.start_time ?? null));
  if (resetting.length > 0) {
    throw new GuardRefusedError(`teardown refuses while a reset is running: ${resetting.map((s) => `${s.id} (pid ${s.reset?.pid})`).join(", ")}; run it again when the reset has ended`);
  }

  if (request.yes && beforeDestroy) await beforeDestroy();
  const lines: string[] = [];
  let exitCode: number = EXIT_CODES.ok;
  let left = 0;
  if (targets.length === 0) lines.push("no slot in the pool or on the host");
  for (const t of targets) {
    const onHost = listed.slots.get(t.id);
    try {
      lines.push(...(await destroyOne(deps, t.ref, onHost, { yes: request.yes, includeLeased: t.holder !== null })).lines);
    } catch (err) {
      left++;
      if (exitCode === EXIT_CODES.ok) exitCode = exitCodeFor(err);
      const mapped = asLeaseError(err);
      lines.push(`${t.id} not destroyed: ${redact(mapped instanceof Error ? mapped.message : String(mapped))}`);
    }
  }
  if (listed.ignored > 0) lines.push(ignoredLine(listed.ignored));
  lines.push(...elevatedPlan(request));
  if (!request.yes) lines.push(DRY_RUN);
  return { exitCode, lines, slotsGone: left === 0, scriptSwitches };
}
