// `get --restore <backup.bak | profile>` (ticket 39, docs/restore.md): which local file the CLI restores into the lease,
// and how it stages it for the broker. A path (WSL, relative, or a Windows drive path) names a backup of the caller's; a
// plain name is a profile, `media/<flavor>/profiles/<name>.bak` in the main checkout (ignored by git, like all media).
// The SQL Server account cannot read the WSL filesystem or the user's Downloads, so the file is copied to
// `<root>\staging\<lease_id>\restore.bak`, where the worker may write and SQL Server may read (ticket 21).

import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FlavorKey } from "../core/flavors.js";
import { UsageError, type RestoreRequest, type Staging } from "../core/lease.js";
import { mediaDir, type MediaOptions } from "../core/media.js";
import { DEFAULT_INSTALL_ROOT, stagingDir } from "../core/names.js";
import { PROFILE_NAME, STAGED_BACKUP_NAME, stagedBackup, type RestoreOptions } from "../core/restore.js";
import { wslPathOf } from "./setup.js";

/** The folder under a flavor's media folder that holds its profiles. */
export const PROFILES_FOLDER = "profiles";

/** A Windows drive path, with either separator. */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

export interface RestoreSourceOptions extends RestoreOptions {
  /** What a relative path is relative to; defaults to the working directory. */
  readonly cwd?: string;
  readonly media?: MediaOptions;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The backup `--restore <value>` names, checked to be a file before any slot is leased. A value with a `/` or `\`, or ending
 * in `.bak`, is a path; anything else is a profile name. The label is what the lease record keeps: `custom` or
 * `profile:<name>`, never the path.
 */
export async function resolveRestoreSource(flavor: FlavorKey, value: string, options: RestoreSourceOptions = {}): Promise<RestoreRequest> {
  const flags = { allowForeignOrigin: options.allowForeignOrigin === true, skipVersionCheck: options.skipVersionCheck === true };
  if (value.trim() === "") throw new UsageError("--restore needs a backup file or a profile name");
  if (WINDOWS_PATH.test(value) || /[\\/]/.test(value) || /\.bak$/i.test(value)) {
    const source = WINDOWS_PATH.test(value) ? wslPathOf(value.replace(/\//g, "\\")) : resolve(options.cwd ?? process.cwd(), value);
    if (!(await isFile(source))) throw new UsageError(`--restore: ${source} is not a file`);
    return { source, label: "custom", ...flags };
  }
  if (!PROFILE_NAME.test(value)) throw new UsageError(`--restore: "${value}" is neither a backup file nor a profile name (letters, digits, '.', '_', '-')`);
  const source = join(mediaDir(flavor, options.media), PROFILES_FOLDER, `${value}.bak`);
  if (!(await isFile(source))) throw new UsageError(`--restore: no ${flavor} profile "${value}": ${source} does not exist (put the backup there; media/README.md)`);
  return { source, label: `profile:${value}`, ...flags };
}

/**
 * Stages into a local folder that stands for `<root>\staging`: `/mnt/c/aras_installations/staging` on the host, a folder of
 * the test's own with the fake host. The Windows path it returns is always the broker's `stagedBackup`.
 */
export function folderStaging(localStaging: string, root: string = DEFAULT_INSTALL_ROOT): Staging {
  const local = (leaseId: string) => join(localStaging, stagingDir(leaseId, root).split("\\").at(-1)!);
  return {
    async stageBackup(leaseId, source) {
      const dir = local(leaseId);
      await mkdir(dir, { recursive: true });
      await copyFile(source, join(dir, STAGED_BACKUP_NAME));
      return stagedBackup(leaseId, root);
    },
    async clear(leaseId) {
      await rm(local(leaseId), { recursive: true, force: true });
    },
  };
}

/** The host's staging folder as WSL sees it. */
export function hostStaging(root: string = DEFAULT_INSTALL_ROOT): Staging {
  return folderStaging(wslPathOf(`${root}\\staging`), root);
}
