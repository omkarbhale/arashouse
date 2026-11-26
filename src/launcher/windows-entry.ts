// The WSL launcher's first step on Windows: `node.exe <...\dist\launcher\windows-entry.js> <runtime id> <args...>`,
// started through interop with this file read from WSL's disk (`\\wsl.localhost\<distro>\...`). It puts this build where
// Windows keeps it, `%LOCALAPPDATA%\arashouse\runtime\<id>\` (dist without source maps, and package.json), when it is not
// there yet, then runs the CLI from there in this process. The CLI and the reset workers it starts then never read a
// module through `\\wsl.localhost`, so stopping WSL cannot pull one from under them. The id is a hash of the build's
// files, so each build gets a folder of its own and a folder never changes once made. Only Node's own modules are
// imported here: nothing else is read from WSL's disk.

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** What a runtime id looks like: 16 hex characters of the build's hash. */
export const RUNTIME_ID = /^[0-9a-f]{16}$/;

/** The marker a finished runtime folder holds; a folder without it is a copy that did not finish. */
export const RUNTIME_MARKER = "runtime.json";

/** How long a runtime of another build is kept after it was made, before a new one clears it away. */
export const RUNTIME_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** `%LOCALAPPDATA%\arashouse\runtime`: beside the machine's state, under the worker user's profile. */
export function runtimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA?.trim();
  return win32.join(local !== undefined && win32.isAbsolute(local) ? local : win32.join(homedir(), "AppData", "Local"), "arashouse", "runtime");
}

/**
 * The runtime folder of build `id`, copied from `source` (the build: its `dist/` and `package.json`) when it is not
 * there. The copy goes to a folder of its own and is renamed into place, so two launchers starting at once both end with
 * one whole copy. Making a new one clears away the runtimes of other builds older than `RUNTIME_KEEP_MS`.
 */
export function ensureRuntime(source: string, id: string, root: string = runtimeRoot(), now: number = Date.now()): string {
  if (!RUNTIME_ID.test(id)) throw new Error(`"${id}" is not a runtime id`);
  const dir = join(root, id);
  if (existsSync(join(dir, RUNTIME_MARKER))) return dir;
  mkdirSync(root, { recursive: true });
  const staging = join(root, `${id}.${process.pid}.${now.toString(36)}.tmp`);
  try {
    cpSync(join(source, "dist"), join(staging, "dist"), { recursive: true, filter: (from) => !from.endsWith(".map") });
    cpSync(join(source, "package.json"), join(staging, "package.json"));
    writeFileSync(join(staging, RUNTIME_MARKER), `${JSON.stringify({ id, from: source, made_at: new Date(now).toISOString() })}\n`);
    try {
      renameSync(staging, dir);
    } catch (err) {
      // Another launcher put the same build in place first.
      if (!existsSync(join(dir, RUNTIME_MARKER))) throw err;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  for (const name of readdirSync(root)) {
    if (name === id) continue;
    const other = join(root, name);
    try {
      const made = statSync(existsSync(join(other, RUNTIME_MARKER)) ? join(other, RUNTIME_MARKER) : other).mtimeMs;
      if (now - made > RUNTIME_KEEP_MS) rmSync(other, { recursive: true, force: true });
    } catch {
      // Gone already, or still in use: left for the next time.
    }
  }
  return dir;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url).toLowerCase() === entry.toLowerCase();
}

if (isMain()) {
  const [id, ...args] = process.argv.slice(2);
  try {
    const dir = ensureRuntime(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), id ?? "");
    const cli = join(dir, "dist", "cli", "index.js");
    process.argv = [process.execPath, cli, ...args];
    await import(pathToFileURL(cli).href);
  } catch (err) {
    process.stderr.write(`arashouse: cannot start the Windows build: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
