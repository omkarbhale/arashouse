// `get --restore` (ticket 39, docs/restore.md): a leaseholder's own SQL Server backup restored over the leased slot's
// database. The CLI copies the file to `staging\<lease_id>\restore.bak` (the SQL Server account cannot read the WSL
// filesystem); the broker reads its header there (`RESTORE HEADERONLY` and `FILELISTONLY`, through a signed procedure,
// ticket 22) and refuses it on the checks below before anything is restored. Pure: the header is data, so both sides
// and the tests share the rules.

import { win32 } from "node:path";
import { FLAVORS, FLAVOR_KEYS, type FlavorKey } from "./flavors.js";
import { nameDenial } from "./guards.js";
import { DEFAULT_INSTALL_ROOT, stagingDir } from "./names.js";

/** The one name a staged backup has: the CLI writes it, the broker and its script derive it from the lease id. */
export const STAGED_BACKUP_NAME = "restore.bak";

/** `<root>\staging\<lease_id>\restore.bak` */
export function stagedBackup(leaseId: string, root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(stagingDir(leaseId, root), STAGED_BACKUP_NAME);
}

/** A profile is `media/<flavor>/profiles/<name>.bak`; its name is a plain file name. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** What a restore may be told to overlook. */
export interface RestoreOptions {
  /** Restore a backup recorded under a deny-list database name (map question Q6). */
  readonly allowForeignOrigin?: boolean;
  /** Keep a restored database whose version rows are not the slot's flavor (as libs-js's CLI allows for engines). */
  readonly skipVersionCheck?: boolean;
}

/** One backup set of the file, as `RESTORE HEADERONLY` lists it. */
export interface BackupSet {
  readonly position: number;
  /** 1 is a full database backup. */
  readonly backupType: number;
  /** The database the backup was taken of. */
  readonly databaseName: string;
  /** The SQL Server that wrote it, `<major>.<minor>.<build>`. */
  readonly softwareVersion: string;
}

/** One file of the backed-up database, as `RESTORE FILELISTONLY` lists it. */
export interface BackupFile {
  readonly logicalName: string;
  /** `D` data, `L` log, `F` full-text catalog, `S` FILESTREAM. */
  readonly type: string;
  /** Its size when restored, in bytes. */
  readonly sizeBytes: number;
}

export interface BackupHeader {
  readonly sets: readonly BackupSet[];
  readonly files: readonly BackupFile[];
}

/** What the restore lands on: the host's SQL Server and the free space where the slot's database files live. */
export interface RestoreTarget {
  /** `SERVERPROPERTY('ProductVersion')`, for example `15.0.2190.7`. */
  readonly serverVersion: string;
  /** Free bytes on the drive of `<root>\sqldata`. */
  readonly freeBytes: number;
}

const GB = 1024 ** 3;

/** Compares two dotted versions number by number; a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function gb(bytes: number): string {
  return (bytes / GB).toFixed(1);
}

/**
 * Why the staged backup must not be restored, or an empty list. Checked on the broker before the slot is touched:
 * one full backup set; written by a SQL Server no newer than the host's ("The backup can not be restored on an older
 * version of SQL Server"); one data file and one log file, which fit in the free space; and not recorded under a
 * deny-list database name, unless `allowForeignOrigin`. arashouse cannot know where the data came from, so the name
 * the backup carries is all it can check.
 */
export function backupProblems(header: BackupHeader, target: RestoreTarget, options: RestoreOptions = {}): string[] {
  const problems: string[] = [];
  if (header.sets.length !== 1) {
    problems.push(`the file holds ${header.sets.length} backup sets; arashouse restores a file with one full database backup`);
  }
  const set = header.sets[0];
  if (set) {
    if (set.backupType !== 1) problems.push(`the backup is not a full database backup (type ${set.backupType})`);
    if (compareVersions(set.softwareVersion, target.serverVersion) > 0) {
      problems.push(`the backup was written by SQL Server ${set.softwareVersion}, newer than this host's ${target.serverVersion}: a backup cannot be restored on an older SQL Server`);
    }
    const denied = nameDenial(set.databaseName);
    if (denied && !options.allowForeignOrigin) {
      problems.push(
        `the backup was taken of the database "${set.databaseName}", which is ${denied}; a lease takes no copy of the captain's systems. ` +
          "If it holds no real data, pass --allow-foreign-origin",
      );
    }
  }
  const data = header.files.filter((f) => f.type === "D");
  const log = header.files.filter((f) => f.type === "L");
  if (data.length !== 1 || log.length !== 1 || header.files.length !== 2) {
    const kinds = header.files.map((f) => f.type).join(", ") || "none";
    problems.push(`the backed-up database has ${header.files.length} files (${kinds}); arashouse restores a database of one data file and one log file`);
  }
  const needed = header.files.reduce((sum, f) => sum + Math.max(0, f.sizeBytes), 0);
  if (needed > target.freeBytes) {
    problems.push(`the restored database needs ${gb(needed)} GB and the drive of sqldata\\ has ${gb(target.freeBytes)} GB free`);
  }
  return problems;
}

/** The registered flavor whose server build the version rows name (`VersionMajor` and `VersionBuild`), if any. */
export function flavorOfVersion(version: Readonly<Record<string, string>>): FlavorKey | undefined {
  return FLAVOR_KEYS.find((key) => {
    const build = FLAVORS[key].serverBuild;
    if (build === null) return false;
    const parts = build.split(".");
    return version.VersionMajor === parts[0] && version.VersionBuild === parts.at(-1);
  });
}

/** The `--flavor` hint for a restored database of another flavor: which flavor's lease it belongs in. */
export function wrongFlavorHint(version: Readonly<Record<string, string>>): string {
  const flavor = flavorOfVersion(version);
  const elsewhere = flavor
    ? `it is a ${flavor} database: restore it into a ${flavor} lease (arashouse get ${flavor} --restore ...)`
    : "no flavor has that build";
  return `${elsewhere}, or pass --skip-version-check to keep it`;
}
