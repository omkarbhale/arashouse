// The broker's `restoreDatabase` verb (ticket 39, docs/restore.md): a leaseholder's own backup, which the CLI staged as
// `staging\<lease_id>\restore.bak`, restored over the leased slot's database. The broker reads the backup's header
// (`read_staged_backup`, ticket 22's procedures) and refuses it on the checks of `backupProblems` before it touches the
// slot; then it stops the slot, restores the backup by its owner (the broker), hands the database's `dbo` back to the
// broker (`adopt_slot_database`: a backup from another instance keeps its own), maps the two Aras users to the slot's
// logins, carries the free slot's `root` and `admin` password hashes into it (so `setLeaseCredentials` logs in with the
// stored `root` password, as on any free slot), removes the reset marker (the database was not reset from the golden),
// checks the version rows against the flavor and starts the slot again. The staged copy is deleted whatever happens.

import { win32 } from "node:path";
import { backupProblems, stagedBackup, wrongFlavorHint, type BackupHeader, type RestoreOptions, type RestoreTarget } from "../core/restore.js";
import { DATABASE_MARKER, slotId, stagingDir, stampFile, type SlotNames, type SlotRef } from "../core/names.js";
import { HostError, isHostError } from "../host/errors.js";
import { assertStagedPath } from "../host/owned.js";
import { ProtocolError, parseSlotStamp, type WireResult } from "./protocol.js";
import { Timings, errorText, seconds, type SlotSystem } from "./provision.js";
import { versionProblem } from "./reset-database.js";
import { startSlotOnHost } from "./start-stop.js";

/** What the host's `read-backup` step reads of a staged backup: its header, the host's SQL Server and the free space. */
export interface StagedBackupReading extends RestoreTarget {
  readonly header: BackupHeader;
}

/** What the host's `restore-staged` step answers. */
export type StagedRestore =
  /** The slot has no database: it was never provisioned (or was destroyed). */
  | { readonly state: "missing" }
  | {
      readonly state: "restored";
      /** The restore's own time, both attempts and the `kill_connections` between them included. */
      readonly restoreMs: number;
      /** How many other sessions `kill_connections` ended. */
      readonly killed: number;
      /** `user_access_desc` straight after the restore, before it was set back to `MULTI_USER`. */
      readonly access: string;
      /** How many of `root` and `admin` got the free slot's password hash. */
      readonly carried: number;
      /** The marker's properties left in the database: none, once removed. */
      readonly marker: Readonly<Record<string, string>>;
      /** The restored `innovator.VARIABLE` rows `VersionMajor`, `VersionMinor`, `VersionServicePack` and `VersionBuild`. */
      readonly version: Readonly<Record<string, string>>;
    };

/** The verb's arguments: the staged file, and what the restore may overlook. */
export interface RestoreDatabaseArgs extends RestoreOptions {
  readonly file: string;
}

const ARG_KEYS = new Set(["file", "allowForeignOrigin", "skipVersionCheck"]);

export function restoreDatabaseArgs(args: Readonly<Record<string, unknown>>): RestoreDatabaseArgs {
  for (const key of Object.keys(args)) if (!ARG_KEYS.has(key)) throw new ProtocolError(`restoreDatabase takes no "${key.slice(0, 32)}" argument`);
  const { file, allowForeignOrigin, skipVersionCheck } = args;
  if (typeof file !== "string" || file.length === 0 || file.length > 260) throw new ProtocolError("restoreDatabase needs the staged backup's file");
  for (const [name, value] of [["allowForeignOrigin", allowForeignOrigin], ["skipVersionCheck", skipVersionCheck]] as const) {
    if (value !== undefined && typeof value !== "boolean") throw new ProtocolError(`restoreDatabase's ${name} is true or false`);
  }
  return { file, allowForeignOrigin: allowForeignOrigin === true, skipVersionCheck: skipVersionCheck === true };
}

/** The lease the slot's stamp names: a restore lands only on a leased slot, and only from that lease's staging folder. */
async function leaseOf(system: SlotSystem, slot: SlotRef, root: string): Promise<string> {
  const id = slotId(slot);
  const bytes = await system.readFile(stampFile(slot, root));
  if (bytes === null) throw new HostError("Refused", `slot ${id} is not provisioned`);
  let leaseId: string | null | undefined;
  try {
    leaseId = parseSlotStamp(JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, "")), slot).leaseId;
  } catch (err) {
    throw new HostError("Quarantine", `the stamp of ${id} is unusable: ${errorText(err)}`);
  }
  if (!leaseId) throw new HostError("Refused", `slot ${id} is not leased: a backup is restored only into a lease`);
  return leaseId;
}

/**
 * `restoreDatabase`: the staged backup over the leased slot's database. Throws a `HostError`: `Refused` for a request,
 * a backup or a restored database that can never work here (the message names why, and for another flavor's database
 * the flavor it belongs to); `Retryable` when the slot did not stop or start. A backup refused by its header leaves the
 * slot untouched; one refused after the restore leaves the leased slot holding it, and `get` sends the slot to be reset.
 */
export async function restoreDatabaseOnHost(system: SlotSystem, slot: SlotRef, names: SlotNames, root: string, args: RestoreDatabaseArgs): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  const timings = new Timings(system);
  const leaseId = await leaseOf(system, slot, root);
  const file = assertStagedPath(slot, args.file, { root }, leaseId);
  const expected = stagedBackup(leaseId, root);
  if (win32.normalize(file).toLowerCase() !== expected.toLowerCase()) throw new HostError("Refused", `a lease's backup is staged as ${expected}, not ${file}`);
  try {
    let reading: StagedBackupReading;
    try {
      reading = await timings.run("read", () => system.readStagedBackup(slot, leaseId));
    } catch (err) {
      throw new HostError("Refused", `the staged backup cannot be read: ${errorText(err)}`, { cause: err });
    }
    const problems = backupProblems(reading.header, reading, args);
    if (problems.length > 0) throw new HostError("Refused", `the backup is not restored into ${id}: ${problems.join("; ")}`);
    const set = reading.header.sets[0]!;
    const files = { data: reading.header.files.find((f) => f.type === "D")!.logicalName, log: reading.header.files.find((f) => f.type === "L")!.logicalName };

    try {
      if (!(await timings.run("stop", () => system.quiesce(slot)))) throw new HostError("Refused", `slot ${id} is not provisioned`);
    } catch (err) {
      if (isHostError(err)) throw err;
      throw new HostError("Retryable", `${id} did not stop for the restore: ${errorText(err)}`, { cause: err });
    }
    let restored;
    try {
      restored = await timings.run("restore", () => system.restoreStaged(slot, leaseId, { databaseName: set.databaseName, ...files }));
    } catch (err) {
      throw new HostError("Refused", `the backup could not be restored into ${id}: ${errorText(err)}`, { cause: err });
    }
    if (restored.state === "missing") throw new HostError("Refused", `slot ${id} has no database (is it provisioned?)`);
    if (restored.marker[DATABASE_MARKER.goldenHash] !== undefined || restored.marker[DATABASE_MARKER.resetAt] !== undefined) {
      throw new HostError("Refused", `the restored database of ${id} still carries a reset marker`);
    }
    const wrong = versionProblem(slot.flavor, restored.version);
    if (wrong && !args.skipVersionCheck) throw new HostError("Refused", `${id}: ${wrong}; ${wrongFlavorHint(restored.version)}`);

    const start = await timings.run("start", () => startSlotOnHost(system, slot, names, root, { agent: false }));
    if (!start.ok) throw new HostError("Retryable", `${id} did not start after the restore: ${start.detail}`);
    const notes = [
      `"${set.databaseName}" from SQL Server ${set.softwareVersion}`,
      `restore ${seconds(restored.restoreMs)} s`,
      restored.killed > 0 ? `${restored.killed} foreign session${restored.killed === 1 ? "" : "s"} ended first` : "no session in the way",
      ...(restored.access === "MULTI_USER" ? [] : [`set back to MULTI_USER from ${restored.access}`]),
      `version ${restored.version.VersionMajor ?? "?"} build ${restored.version.VersionBuild ?? "?"}${wrong ? " (not the flavor's: --skip-version-check)" : ""}`,
      ...(args.allowForeignOrigin ? ["--allow-foreign-origin"] : []),
      `${restored.carried} password${restored.carried === 1 ? "" : "s"} carried`,
    ];
    return { ok: true, detail: `restored a backup into ${id} in ${seconds(system.now() - started)} s (${notes.join("; ")}; ${timings})` };
  } finally {
    // The staged copy goes whatever happened; the lease's staging folder too, once it is empty.
    await system.removeFile(expected).catch(() => undefined);
    await system.removeEmptyDir(stagingDir(leaseId, root)).catch(() => undefined);
  }
}
