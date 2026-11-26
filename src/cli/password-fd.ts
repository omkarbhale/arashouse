// `arashouse get --password-fd <n>` (ticket 34): the lease's password goes to a descriptor the caller opened and
// this process inherited (`3>pw.txt`, a pipe), instead of into the `get --json` output, for a caller that does not
// want it on stdout. Only 3 and up: 0 to 2 are stdin, stdout and stderr, which `--json` and the human text own.
//
// Node opens descriptors of its own before any of this code runs (its event loop's epoll, eventfd and signal
// pipes), and those are open too, so "open" is not enough: writing the password to one would hand it to Node's own
// machinery. The event loop's first descriptor is an `anon_inode:` one at the lowest free number, so every
// descriptor the process inherited is below the first `anon_inode:` in `/proc/self/fd`; one at or above it is
// refused, as is anything that is not a file, a pipe, a socket or a character device.
//
// On Windows there is no `/proc` to tell an inherited descriptor from Node's own, and a descriptor is inherited by
// number only from a libuv parent, so `--password-fd` is refused there: `get --json` hands the password over instead.
// From WSL, the launcher (src/launcher/) keeps `--password-fd` on the WSL side.

import { fstatSync, readdirSync, readlinkSync, writeSync } from "node:fs";
import { UsageError } from "../core/lease.js";
import type { Secret } from "../core/secret.js";

/** The lowest descriptor Node's event loop opened (`anon_inode:`), or undefined where `/proc` cannot tell. */
function firstOwnDescriptor(): number | undefined {
  let fds: number[];
  try {
    fds = readdirSync("/proc/self/fd").map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  } catch {
    return undefined;
  }
  for (const fd of fds) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`).startsWith("anon_inode:")) return fd;
    } catch {
      // Closed between the listing and the read: not the one.
    }
  }
  return undefined;
}

/** The message `--password-fd` is refused with on Windows. */
export const FD_OPTION_REFUSED_ON_WINDOWS = "--password-fd is not available on Windows: use `get --json`, which holds the password";

/** The descriptor `--password-fd` names: an integer from 3 to 1023 that this process inherited open. */
export function parsePasswordFd(text: string, platform: NodeJS.Platform = process.platform): number {
  const fd = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(fd) || fd < 3 || fd > 1023) throw new UsageError("--password-fd must be a descriptor from 3 to 1023 (0 to 2 are stdin, stdout and stderr)");
  if (platform === "win32") throw new UsageError(FD_OPTION_REFUSED_ON_WINDOWS);
  const notOpen = new UsageError(`--password-fd ${fd} is not open: open it for the command, for example \`${fd}>file\``);
  let usable: boolean;
  try {
    const st = fstatSync(fd);
    usable = st.isFile() || st.isFIFO() || st.isSocket() || st.isCharacterDevice();
  } catch {
    throw notOpen;
  }
  const own = firstOwnDescriptor();
  if (!usable || (own !== undefined && fd >= own)) throw notOpen;
  return fd;
}

/** Writes the password and a newline to `fd`, which stays open: it is the caller's. */
export function writePasswordFd(fd: number, password: Secret): void {
  const bytes = Buffer.from(`${password.reveal()}\n`, "utf8");
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
}
