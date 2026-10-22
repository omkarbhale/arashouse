// What a host driver asserts before it acts: every name and path derived from the slot record, and
// every staged or golden path a call carries. The real host and the fake both run these, so a call
// that names something on the deny-list fails the same way in both.

import { win32 } from "node:path";
import { GuardError, assertOwned, assertValidRoot, type OwnedOptions } from "../core/guards.js";
import { isFlavorKey, type FlavorKey } from "../core/flavors.js";
import {
  APP_POOL_ROLES,
  DEFAULT_INSTALL_ROOT,
  goldenDir,
  slotNames,
  slotNumber,
  type SlotNames,
  type SlotRef,
} from "../core/names.js";
import { HostError, refusedFromGuard } from "./errors.js";

export interface OwnedContext {
  /** The install root; defaults to `DEFAULT_INSTALL_ROOT`. */
  readonly root?: string;
  /** Forwarded to `assertOwned` for paths: reports a junction or other reparse point. */
  readonly isReparsePoint?: (path: string) => boolean;
  readonly realPath?: (path: string) => string;
}

function ownedOptions(ctx: OwnedContext): OwnedOptions {
  return { root: ctx.root, isReparsePoint: ctx.isReparsePoint, realPath: ctx.realPath };
}

/** Runs `fn`, turning a `GuardError` into the `Refused` host error. */
export function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof GuardError) throw refusedFromGuard(err);
    throw err;
  }
}

/** Refuses anything that is not a registered (flavor, number) pair before a name is derived from it. */
function assertSlotRecord(slot: unknown): asserts slot is SlotRef {
  const record = slot as Partial<SlotRef> | null | undefined;
  let ok = typeof record === "object" && record !== null && isFlavorKey(record.flavor);
  if (ok) {
    try {
      slotNumber((record as SlotRef).slot);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    const subject = typeof record === "object" && record !== null ? `${String(record.flavor)}/${String(record.slot)}` : String(slot);
    throw new GuardError("bad-slot", "database", subject, "the slot record is not a registered (flavor, number)");
  }
}

/**
 * Asserts the root and every name and folder the slot owns, from the slot record alone, and returns
 * them. This is the first line of every call that acts on one slot.
 */
export function assertSlotOwned(slot: SlotRef, ctx: OwnedContext = {}): SlotNames {
  return guarded(() => {
    assertSlotRecord(slot);
    const root = ctx.root ?? DEFAULT_INSTALL_ROOT;
    const options = ownedOptions(ctx);
    assertOwned("root", root, undefined, options);
    const names = slotNames(slot, root);
    assertOwned("database", names.database, slot);
    assertOwned("alias", names.alias, slot);
    for (const role of APP_POOL_ROLES) assertOwned("appPool", names.appPools[role], slot);
    assertOwned("service", names.service, slot);
    assertOwned("login", names.logins.dbo, slot);
    assertOwned("login", names.logins.reg, slot);
    assertOwned("path", names.slotDir, slot, options);
    assertOwned("path", names.vaultDir, slot, options);
    assertOwned("path", names.goldenDir, slot, options);
    return names;
  });
}

/** A flavor named on its own (the baseline calls); refused unless it is a registered key. */
export function assertFlavorOwned(flavor: FlavorKey, ctx: OwnedContext = {}): void {
  guarded(() => {
    if (!isFlavorKey(flavor)) {
      throw new GuardError("bad-slot", "path", String(flavor), "the flavor is not registered");
    }
    const root = ctx.root ?? DEFAULT_INSTALL_ROOT;
    assertOwned("root", root, undefined, ownedOptions(ctx));
    assertOwned("path", goldenDir(flavor, root), undefined, ownedOptions(ctx));
  });
}

function within(path: string, folder: string): boolean {
  const lower = path.toLowerCase();
  const prefix = folder.toLowerCase() + "\\";
  return lower.startsWith(prefix) && lower.length > prefix.length;
}

function assertInside(kind: string, canonical: string, folder: string): void {
  if (!within(canonical, folder)) {
    throw new HostError("Refused", `refused path "${canonical}": a ${kind} must be inside ${folder}`);
  }
}

/**
 * A path staged by the leaseholder: a file or folder inside `staging\<lease_id>`, never a lease folder
 * itself or a file loose in `staging`. When `leaseId` is given, the lease folder must be that lease's.
 * Returns the path canonical.
 */
export function assertStagedPath(slot: SlotRef, path: string, ctx: OwnedContext = {}, leaseId?: string | null): string {
  const root = ctx.root ?? DEFAULT_INSTALL_ROOT;
  const canonical = guarded(() => assertOwned("path", path, slot, ownedOptions(ctx)));
  const staging = win32.join(assertValidRoot(root), "staging");
  assertInside("staged path", canonical, staging);
  if (!canonical.slice(staging.length + 1).includes("\\")) {
    throw new HostError("Refused", `refused path "${canonical}": a staged path must be inside ${staging}\\<lease_id>`);
  }
  if (leaseId) assertInside("staged path", canonical, win32.join(staging, leaseId));
  return canonical;
}

/** A path inside this slot's flavor's golden folder (a shipped or built backup). Returns it canonical. */
export function assertGoldenPath(slot: SlotRef, path: string, ctx: OwnedContext = {}): string {
  const root = ctx.root ?? DEFAULT_INSTALL_ROOT;
  const canonical = guarded(() => assertOwned("path", path, slot, ownedOptions(ctx)));
  assertInside("golden path", canonical, goldenDir(slot.flavor, assertValidRoot(root)));
  return canonical;
}
