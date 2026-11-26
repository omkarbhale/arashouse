// `arashouse migrate-state [--yes]`, in WSL only: moves the pool's state from WSL's `~/.arashouse` to the Windows home
// (`%LOCALAPPDATA%\arashouse`, docs/windows-native.md, "Migrating a pool from WSL's state to Windows"). A dry run
// without `--yes`. With it, under the old state's own lock (the protocol every earlier build takes, so none of them can
// write while it runs): `config.json`, `events.log`, `recipes/`, `logs/` and `leases/` (the held leases' passwords)
// are copied, `state.json` last; then WSL's `state.json` and `leases/` are renamed aside, never deleted, so the launcher
// runs and no earlier build can act on a stale pool. Held leases carry over with their passwords. It refuses a Windows
// home that already holds a state, and, without being told twice, a pool with a reset running or a `get --wait` queued.

import { copyFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock } from "../core/lock.js";
import { parseState } from "../core/state.js";
import { writeFileAtomic } from "../core/store.js";

/** What the copy takes, besides `state.json` (copied last). */
const FILES = ["config.json", "events.log"] as const;
const FOLDERS = ["recipes", "logs", "leases"] as const;

export interface MigrateRequest {
  /** WSL's state home (`~/.arashouse`). */
  readonly from: string;
  /** The Windows home, as this side opens it (`/mnt/c/Users/<you>/AppData/Local/arashouse`). */
  readonly to: string;
  /** How the Windows home is named to the reader (`C:\Users\<you>\AppData\Local\arashouse`). */
  readonly toShown: string;
  readonly yes: boolean;
  /** `--yes` given twice in spirit: go on with a reset running or a waiter queued. */
  readonly busyOk: boolean;
  readonly now?: () => Date;
}

export interface MigrateResult {
  readonly code: number;
  readonly lines: readonly string[];
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function copyTree(from: string, to: string): Promise<number> {
  let files = 0;
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) files += await copyTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) {
      await copyFile(join(from, entry.name), join(to, entry.name));
      files++;
    }
  }
  return files;
}

export async function migrateState(request: MigrateRequest): Promise<MigrateResult> {
  const { from, to, toShown } = request;
  const legacy = join(from, "state.json");
  if (!(await exists(legacy))) return { code: 1, lines: [`there is no state to move: ${legacy} does not exist (moved already?)`] };
  if (await exists(join(to, "state.json"))) {
    return { code: 1, lines: [`${toShown} already holds a state.json: the pool's state is on Windows already; nothing was moved (WSL's is ${legacy})`] };
  }
  const state = parseState(await readFile(legacy, "utf8"), legacy);
  const slots = Object.values(state.slots);
  const leased = slots.filter((s) => s.status === "leased");
  const resetting = slots.filter((s) => s.status === "resetting");
  const lines = [
    `from ${from} to ${toShown}: ${slots.length} slots (${leased.length} leased: ${leased.map((s) => `${s.id} to ${s.lease?.holder ?? "?"}`).join(", ") || "none"}), ` +
      `${resetting.length} resetting, ${state.queue.length} waiting`,
    `copies ${[...FILES, ...FOLDERS.map((f) => `${f}/`)].join(", ")}, then state.json; then renames WSL's state.json and leases/ aside`,
  ];
  const busy = resetting.length > 0 || state.queue.length > 0;
  if (busy && !request.busyOk) {
    lines.push(
      `refused: ${resetting.length > 0 ? `${resetting.map((s) => s.id).join(", ")} ${resetting.length === 1 ? "is" : "are"} being reset by a WSL process` : ""}` +
        `${resetting.length > 0 && state.queue.length > 0 ? ", and " : ""}${state.queue.length > 0 ? `${state.queue.length} get --wait ${state.queue.length === 1 ? "is" : "are"} queued` : ""}; ` +
        "wait for the pool to be quiet, or give --yes --busy-ok (a WSL reset's slot comes back dirty and is reset again; a WSL waiter keeps waiting on the old state)",
    );
    return { code: 1, lines };
  }
  if (!request.yes) {
    lines.push("dry run: nothing was changed; run again with --yes to move it");
    return { code: 0, lines };
  }

  // The old state's lock: no build, old or new, writes WSL's state while it is copied and set aside.
  const lock = await acquireLock(join(from, "state.lock"), { timeoutMs: 30_000 });
  try {
    const stamp = (request.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    await mkdir(to, { recursive: true, mode: 0o700 });
    let files = 0;
    for (const name of FILES) {
      if (await exists(join(from, name))) {
        await copyFile(join(from, name), join(to, name));
        files++;
      }
    }
    for (const name of FOLDERS) if (await exists(join(from, name))) files += await copyTree(join(from, name), join(to, name));
    // The state last, as read under the lock (it may have changed since the plan was read).
    const text = await readFile(legacy, "utf8");
    parseState(text, legacy);
    await writeFileAtomic(join(to, "state.json"), text);
    files++;
    await rename(legacy, `${legacy}.moved-to-windows-${stamp}`);
    if (await exists(join(from, "leases"))) await rename(join(from, "leases"), join(from, `leases.moved-to-windows-${stamp}`));
    lines.push(
      `moved: ${files} files to ${toShown}; WSL's state.json and leases/ are now *.moved-to-windows-${stamp} (delete them once the pool works from Windows)`,
      "next: arashouse doctor (and doctor --fix for anything left dirty)",
    );
    return { code: 0, lines };
  } finally {
    await lock.release();
  }
}
