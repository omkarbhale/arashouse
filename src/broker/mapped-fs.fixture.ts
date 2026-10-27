// For the broker's tests: the install root `C:\aras_installations` mapped onto a temporary folder, so
// the verbs read real files on Linux by their Windows paths.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DEFAULT_INSTALL_ROOT, STAMP_FILE_NAME, slotDir, slotId, type SlotRef } from "../core/names.js";
import { nodeBrokerFs, type BrokerFs } from "./fs.js";

export interface MappedRoot {
  /** The temporary folder that stands for the root. */
  readonly dir: string;
  readonly fs: BrokerFs;
  /** The local path of a Windows path under the root. */
  local(path: string): string;
  /** Creates a slot folder, with a stamp unless `stamp` is null (a string is written as it is). */
  slot(ref: SlotRef, stamp?: object | string | null): void;
  /** Turns a slot folder into a symbolic link to `target` (a junction on Windows). */
  linkSlot(ref: SlotRef, target: string): void;
  cleanup(): void;
}

export function mappedRoot(root: string = DEFAULT_INSTALL_ROOT): MappedRoot {
  const dir = mkdtempSync(join(tmpdir(), "arashouse-broker-"));
  const prefix = `${root.toLowerCase()}\\`;
  const local = (path: string): string => {
    if (path.toLowerCase() === root.toLowerCase()) return dir;
    if (!path.toLowerCase().startsWith(prefix)) throw new Error(`not under the mapped root: ${path}`);
    return join(dir, ...path.slice(prefix.length).split("\\"));
  };
  const fromLocal = (path: string): string => {
    const rel = relative(dir, path);
    if (rel.startsWith("..")) return path;
    return rel === "" ? root : `${root}\\${rel.split(sep).join("\\")}`;
  };
  const stampOf = (ref: SlotRef) => ({ slotId: slotId(ref), flavor: ref.flavor, goldenHash: "g1", lastResetAt: "2026-10-27T00:00:00.000Z" });
  return {
    dir,
    fs: nodeBrokerFs({ toLocal: local, fromLocal }),
    local,
    slot(ref, stamp = stampOf(ref)) {
      const folder = local(slotDir(ref, root));
      mkdirSync(folder, { recursive: true });
      if (stamp !== null) writeFileSync(join(folder, STAMP_FILE_NAME), typeof stamp === "string" ? stamp : JSON.stringify(stamp));
    },
    linkSlot(ref, target) {
      const folder = local(slotDir(ref, root));
      mkdirSync(join(folder, ".."), { recursive: true });
      symlinkSync(target, folder);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
