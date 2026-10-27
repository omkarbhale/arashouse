// The broker's `resetDatabase` verb (ticket 31, docs/reset-database.md): the database half of a reset. The golden's
// `db\ootb.bak` is restored over the slot database by its owner, the broker (the owner restore of spike 06): no
// procedure restores it, and the broker's login, in no server role, cannot restore over a database it does not own.
// `kill_connections` (ticket 22) ends any other session in the database first: an idle one holds the restore for
// about 20 s and then fails it with 3101. One that comes back in between gets the same: ended, and the restore runs
// once more. Then the database is `MULTI_USER`, its two users are mapped to the slot's logins again, and the marker
// (`DATABASE_MARKER`) is written. The owner survives the restore and the vault URL is alias-relative, so neither is
// fixed; the Aras passwords of `root` and `admin` are changed through the slot's server, after it starts (ticket 32).

import { win32 } from "node:path";
import { FLAVORS, type FlavorKey } from "../core/flavors.js";
import { DATABASE_MARKER, goldenLayout, slotId, type SlotRef } from "../core/names.js";
import { HostError } from "../host/errors.js";
import { assertGoldenPath } from "../host/owned.js";
import { ProtocolError, type WireResult } from "./protocol.js";
import type { SlotSystem } from "./provision.js";

/** What a reset writes into the slot database after the restore. */
export interface DatabaseMarker {
  /** The golden manifest hash the database was restored from. */
  readonly goldenHash: string;
  /** ISO time of the restore. */
  readonly resetAt: string;
}

/** What the host's `reset-database` step answers. */
export type DatabaseReset =
  /** The slot has no database: it was never provisioned (or was destroyed). */
  | { readonly state: "missing" }
  | {
      readonly state: "restored";
      /** The restore's own time, both attempts and the `kill_connections` between them included. */
      readonly restoreMs: number;
      /** How many other sessions `kill_connections` ended, before the restore and before its retry. */
      readonly killed: number;
      /** `user_access_desc` straight after the restore, before it was set back to `MULTI_USER`. */
      readonly access: string;
      /** The marker as read back from the database. */
      readonly marker: Readonly<Record<string, string>>;
      /** The restored `innovator.VARIABLE` rows `VersionMajor`, `VersionMinor`, `VersionServicePack` and `VersionBuild`. */
      readonly version: Readonly<Record<string, string>>;
    };

/** The verb's arguments: the backup and the golden hash it carries, as `BackupRef` names them. */
export interface ResetDatabaseArgs {
  readonly file: string;
  readonly hash: string;
}

const HASH = /^[0-9a-f]{64}$/;

export function resetDatabaseArgs(args: Readonly<Record<string, unknown>>): ResetDatabaseArgs {
  for (const key of Object.keys(args)) if (key !== "file" && key !== "hash") throw new ProtocolError(`resetDatabase takes no "${key.slice(0, 32)}" argument`);
  const { file, hash } = args;
  if (typeof file !== "string" || file.length === 0 || file.length > 260) throw new ProtocolError("resetDatabase needs the backup's file");
  if (typeof hash !== "string" || !HASH.test(hash)) throw new ProtocolError("resetDatabase needs the golden manifest hash the backup carries");
  return { file, hash };
}

function seconds(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

/**
 * Why the restored version rows are not the flavor's, or undefined. The major version and the build are compared with
 * the registry's `serverBuild` (`12.0.0.24090`: `VersionMajor` 12, `VersionBuild` 24090); the minor and service pack
 * are written differently by each release line, so they are reported, not compared.
 */
export function versionProblem(flavor: FlavorKey, version: Readonly<Record<string, string>>): string | undefined {
  const build = FLAVORS[flavor].serverBuild;
  if (build === null) return undefined;
  const parts = build.split(".");
  if (version.VersionMajor === parts[0] && version.VersionBuild === parts.at(-1)) return undefined;
  return `the restored database is version ${versionText(version)}, not the ${flavor} server build ${build}`;
}

function versionText(version: Readonly<Record<string, string>>): string {
  const major = version.VersionMajor ?? "?";
  const minor = version.VersionMinor ?? "?";
  const sp = version.VersionServicePack ? ` ${version.VersionServicePack}` : "";
  return `${major}.${minor}${sp} build ${version.VersionBuild ?? "?"}`;
}

/**
 * `resetDatabase`: restores the golden's `ootb.bak` over the slot database and fixes it up. The backup must be that
 * file and carry the golden's manifest hash now; the hash becomes the marker. Throws a `HostError`: `Refused` for a
 * request or golden that can never work, `Retryable` while a golden is moved into place or changed under the reset,
 * `Quarantine` when the restored database is not what the reset wrote.
 */
export async function resetDatabaseOnHost(
  system: SlotSystem,
  slot: SlotRef,
  root: string,
  backup: ResetDatabaseArgs,
  ootbUnusable: (flavor: FlavorKey) => Promise<string | undefined>,
): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  const expected = goldenLayout(slot.flavor, root).ootbBackup;
  const file = assertGoldenPath(slot, backup.file, { root });
  // The golden holds one backup; a leaseholder's own goes through restoreDatabase (ticket 39).
  if (win32.normalize(file).toLowerCase() !== expected.toLowerCase()) throw new HostError("Refused", `a reset restores ${expected} only, not ${file}`);

  const golden = await system.golden(slot.flavor);
  if (golden.state === "promoting") throw new HostError("Retryable", `a new ${slot.flavor} golden is being moved into place; reset ${id} when it is done`);
  if (golden.state === "unusable") throw new HostError("Refused", `the ${slot.flavor} golden cannot be restored from: ${golden.detail}`);
  if (golden.hash !== backup.hash) {
    throw new HostError("Retryable", `the ${slot.flavor} golden is ${golden.hash.slice(0, 12)} now, not the ${backup.hash.slice(0, 12)} the reset began with`);
  }
  const unusable = await ootbUnusable(slot.flavor);
  if (unusable) throw new HostError("Refused", `the ${slot.flavor} golden cannot be restored from: ${unusable}`);
  const checked = system.now();

  const marker: DatabaseMarker = { goldenHash: golden.hash, resetAt: new Date(system.now()).toISOString() };
  const result = await system.resetDatabase(slot, marker);
  if (result.state === "missing") throw new HostError("Refused", `slot ${id} has no database (is it provisioned?)`);
  if (result.marker[DATABASE_MARKER.goldenHash] !== marker.goldenHash || result.marker[DATABASE_MARKER.resetAt] !== marker.resetAt) {
    throw new HostError("Quarantine", `the marker of ${id}'s database does not read back as written`);
  }
  const wrong = versionProblem(slot.flavor, result.version);
  if (wrong) throw new HostError("Quarantine", `${id}: ${wrong}`);

  const notes = [
    `restore ${seconds(result.restoreMs)} s`,
    result.killed > 0 ? `${result.killed} foreign session${result.killed === 1 ? "" : "s"} ended first` : "no session in the way",
    ...(result.access === "MULTI_USER" ? [] : [`set back to MULTI_USER from ${result.access}`]),
    `version ${versionText(result.version)}`,
    `golden check ${seconds(checked - started)} s`,
  ];
  return {
    ok: true,
    detail: `database of ${id} restored from golden ${golden.hash.slice(0, 12)} in ${seconds(system.now() - started)} s (${notes.join("; ")})`,
  };
}
