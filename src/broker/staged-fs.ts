// The broker's reads of a staged folder (ticket 40), on local paths. The worker may change `staging\` while the broker
// reads it, and the broker runs as a local administrator, so a staged file is never opened by name alone: it is
// looked at without following a link (a plain file, one link), opened, and the open handle must be that same file
// (device and file id). A link, junction or hard link swapped in between is refused, so the broker cannot be made
// to copy a file the worker could not read into a slot the worker can. Writes into the slot go through a temporary
// file renamed over the target, so a hard link left in the slot's tree is replaced, not written through. Node
// reports a junction, as well as a symbolic link, as a symbolic link.

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HostError } from "../host/errors.js";
import type { EntryKind, StagedListing } from "./provision.js";

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** What is at `path`, without following a link. */
export async function entryKind(path: string): Promise<EntryKind> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "link";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "dir";
    return "other";
  } catch (err) {
    if (isMissing(err)) return "missing";
    throw err;
  }
}

/** The most entries one walk looks at. */
const MAX_ENTRIES = 200_000;

/** Walks `dir` without following a link: its plain files, and what is neither a plain file nor a plain folder. */
export async function listStaged(dir: string): Promise<StagedListing> {
  if ((await entryKind(dir)) !== "dir") throw new HostError("Refused", `the staged folder ${dir} is missing or not a plain folder`);
  const files: { path: string; size: number }[] = [];
  const refused: string[] = [];
  let seen = 0;
  // An entry the broker cannot even look at (a symbolic link WSL made is a reparse point Windows answers EACCES for) is
  // refused like a link, not an error: the deploy is refused and nothing is copied.
  const lookAt = (full: string) => lstat(full).catch(() => undefined);
  const walk = async (folder: string, rel: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
      refused.push(rel === "" ? "." : rel);
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) throw new HostError("Refused", `the staged folder has more than ${MAX_ENTRIES} entries`);
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const full = join(folder, entry.name);
      const info = await lookAt(full);
      if (info === undefined || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) refused.push(path);
      else if (info.isDirectory()) await walk(full, path);
      else files.push({ path, size: info.size });
    }
  };
  await walk(dir, "");
  return { files, refused };
}

/** Opens `path` for reading and checks the handle is the plain, single-link file `lstat` saw at that name. */
async function openChecked(path: string): Promise<FileHandle> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (err) {
    if (isMissing(err)) throw new HostError("Refused", `the staged file ${path} is gone`);
    throw err;
  }
  if (!before.isFile()) throw new HostError("Refused", `the staged ${path} is not a plain file`);
  if (before.nlink !== 1n) throw new HostError("Refused", `the staged file ${path} has ${before.nlink} hard links`);
  const handle = await open(path, "r");
  try {
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1n) {
      throw new HostError("Refused", `the staged file ${path} changed while it was opened`);
    }
    return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** A staged file's bytes, from a checked handle; refused past `maxBytes`. */
export async function readStaged(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await openChecked(path);
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) throw new HostError("Refused", `the staged file ${path} is larger than ${maxBytes} bytes`);
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/** Copies a staged file, from a checked handle, to `to` through a temporary file beside it renamed over it. */
export async function copyStaged(from: string, to: string): Promise<{ bytes: number; sha256: string }> {
  const source = await openChecked(from);
  const temp = join(dirname(to), `.arashouse-deploy-${randomBytes(6).toString("hex")}.tmp`);
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    await mkdir(dirname(to), { recursive: true });
    const target = await open(temp, "wx");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        await target.write(buffer, 0, bytesRead);
        bytes += bytesRead;
      }
    } finally {
      await target.close();
    }
    await rename(temp, to);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  } finally {
    await source.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Deletes the plain file at `path`; false when there is none. A folder or link is refused. */
export async function removeFile(path: string): Promise<boolean> {
  const kind = await entryKind(path);
  if (kind === "missing") return false;
  if (kind !== "file") throw new HostError("Refused", `${path} is a ${kind === "dir" ? "folder" : kind}, not a file`);
  await unlink(path);
  return true;
}

/** Removes a link or junction itself, never what it points at: `unlink`, or `rmdir` for a directory link on Windows. */
async function removeLink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EISDIR" && code !== "EACCES") throw err;
    await rmdir(path);
  }
}

/**
 * Removes the staged folder `path` and everything in it, never following a link or junction (one the worker put there
 * may point at `secrets\`): each link is removed itself. Nothing when it does not exist.
 */
export async function removeStaged(path: string): Promise<void> {
  const kind = await entryKind(path);
  if (kind === "missing") return;
  if (kind !== "dir") {
    await (kind === "link" ? removeLink(path) : unlink(path));
    return;
  }
  for (const entry of await readdir(path)) {
    const full = join(path, entry);
    const info = await lstat(full).catch(() => undefined);
    // One that cannot be looked at (a WSL symbolic link) is removed as a link is: the entry itself, never followed.
    if (info === undefined || info.isSymbolicLink()) await removeLink(full);
    else if (info.isDirectory()) await removeStaged(full);
    else await unlink(full);
  }
  await rmdir(path);
}
