// The broker's view of the disk, as a seam: the verbs name Windows paths (`C:\aras_installations\...`)
// and this maps them to the local filesystem. On Windows the map is the identity; the tests on Linux
// map the install root to a temporary folder, so the same verbs run offline.

import { lstatSync, realpathSync } from "node:fs";
import { readFile, readdir, stat, statfs } from "node:fs/promises";

export interface BrokerFs {
  /** The file's text, or null when it does not exist. Throws when it is larger than `maxBytes`. */
  readText(path: string, maxBytes: number): Promise<string | null>;
  /** The names of the folders in `path` that are not links or junctions, or null when `path` does not exist. */
  listDirs(path: string): Promise<string[] | null>;
  /** Whether `path` is a folder. */
  isDirectory(path: string): Promise<boolean>;
  /** Free bytes available to the broker on the volume that holds `path`. */
  freeBytes(path: string): Promise<number>;
  /** For the guards: whether `path` is a junction, symbolic link or other reparse point (false when it does not exist). */
  isReparsePoint(path: string): boolean;
  /** For the guards: the real path of `path` (itself when it does not exist). */
  realPath(path: string): string;
  /** The local path of a Windows path, for code that reads a tree itself (the golden manifest check); itself on Windows. */
  localPath(path: string): string;
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export interface NodeBrokerFsOptions {
  /** Maps a Windows path to a local one; the identity on Windows. */
  readonly toLocal?: (path: string) => string;
  /** Maps a local path back to a Windows one, for `realPath`; the identity on Windows. */
  readonly fromLocal?: (path: string) => string;
}

/** The broker's disk through `node:fs`. */
export function nodeBrokerFs(options: NodeBrokerFsOptions = {}): BrokerFs {
  const local = options.toLocal ?? ((p: string) => p);
  const back = options.fromLocal ?? ((p: string) => p);
  return {
    async readText(path, maxBytes) {
      try {
        const info = await stat(local(path));
        if (info.size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
        return await readFile(local(path), "utf8");
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    async listDirs(path) {
      try {
        const entries = await readdir(local(path), { withFileTypes: true });
        return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    async isDirectory(path) {
      try {
        return (await stat(local(path))).isDirectory();
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
    async freeBytes(path) {
      const info = await statfs(local(path));
      return info.bavail * info.bsize;
    },
    isReparsePoint(path) {
      try {
        // Node reports a junction, as well as a symbolic link, as a symbolic link.
        return lstatSync(local(path)).isSymbolicLink();
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
    localPath: (path) => local(path),
    realPath(path) {
      try {
        return back(realpathSync.native(local(path)));
      } catch (err) {
        if (isMissing(err)) return path;
        throw err;
      }
    },
  };
}
