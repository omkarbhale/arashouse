// The broker's `backupDatabase` verb (ticket 43, docs/extract.md): a `COPY_ONLY` backup of a leased slot's database
// for its leaseholder to take out (`arashouse extract db`). The broker owns the slot database, so it backs it up with
// no server role. SQL Server writes the backup as its own account, which may write `sqldata\` only (ticket 21), so the
// backup lands at `extractBackupScratch` first; the broker then copies it to the path the leaseholder named inside
// `staging\<lease_id>\` and removes the scratch copy.
//
// Only a leased slot's database: the slot's stamp must name a lease, and the path must be inside that lease's staging
// folder, with no junction in it, checked again just before the copy (the worker may change `staging\`). The copy
// never replaces a file.

import { win32 } from "node:path";
import { extractBackupScratch, slotId, stampFile, type SlotRef } from "../core/names.js";
import { HostError } from "../host/errors.js";
import { assertStagedPath, type OwnedContext } from "../host/owned.js";
import { ProtocolError, parseSlotStamp, type WireResult } from "./protocol.js";
import { seconds, type SlotSystem } from "./provision.js";

/** What the host's `backup-database` step answers. */
export type DatabaseBackup =
  /** The slot has no database. */
  | { readonly state: "missing" }
  /** The backup is at `extractBackupScratch`: how long it took and how large it is. */
  | { readonly state: "backed-up"; readonly backupMs: number; readonly bytes: number };

/** The verb's arguments: the staged path of the backup, as `HostDriver.backupDatabase` names it. */
export interface BackupDatabaseArgs {
  readonly path: string;
}

export function backupDatabaseArgs(args: Readonly<Record<string, unknown>>): BackupDatabaseArgs {
  for (const key of Object.keys(args)) if (key !== "path") throw new ProtocolError(`backupDatabase takes no "${key.slice(0, 32)}" argument`);
  const { path } = args;
  if (typeof path !== "string" || path.length === 0 || path.length > 260) throw new ProtocolError("backupDatabase needs the staged path of the backup");
  return { path };
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** The lease the slot's stamp names; `Refused` when the slot is not provisioned or not leased. */
async function leaseOf(system: SlotSystem, slot: SlotRef, root: string): Promise<string> {
  const id = slotId(slot);
  const bytes = await system.readFile(stampFile(slot, root));
  if (bytes === null) throw new HostError("Refused", `slot ${id} is not provisioned`);
  let leaseId: string | null | undefined;
  try {
    leaseId = parseSlotStamp(JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, "")), slot).leaseId;
  } catch {
    throw new HostError("Quarantine", `the stamp of ${id} is unusable`);
  }
  if (!leaseId) throw new HostError("Refused", `slot ${id} is not leased: only a leased slot's database is backed up`);
  return leaseId;
}

/** `backupDatabase`: a `COPY_ONLY` backup of the leased slot's database, copied to `args.path` in its lease's staging folder. */
export async function backupDatabaseOnHost(system: SlotSystem, slot: SlotRef, root: string, owned: OwnedContext, args: BackupDatabaseArgs): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  const leaseId = await leaseOf(system, slot, root);
  const staged = assertStagedPath(slot, args.path, owned, leaseId);
  if (!staged.toLowerCase().endsWith(".bak")) throw new HostError("Refused", `refused path "${staged}": a backup is staged as a .bak file`);

  const scratch = extractBackupScratch(slot, root);
  try {
    const backup = await system.backupDatabase(slot);
    if (backup.state === "missing") throw new HostError("Refused", `slot ${id} has no database (is it provisioned?)`);
    // The worker may have changed staging\ while the backup ran: the path is checked again just before the copy.
    assertStagedPath(slot, staged, owned, leaseId);
    if (!(await system.copyFile(scratch, staged))) throw new HostError("Refused", `refused path "${staged}": it exists, and a backup never replaces a file`);
    return {
      ok: true,
      detail: `backed up the database of ${id} (COPY_ONLY, ${megabytes(backup.bytes)} MB, ${seconds(backup.backupMs)} s) to ${win32.basename(staged)} in ${seconds(system.now() - started)} s`,
    };
  } finally {
    await system.removeFile(scratch);
  }
}
