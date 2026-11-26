// What the host suites need to know of the side they run on: natively on Windows (the native acceptance) or from WSL
// (where `node dist/cli/index.js` is the launcher of the Windows build). The install root as this process opens it, the
// pool's state home as the CLI under test keeps it, the broker's transport, Windows paths and the tools' working folder.

import { execFileSync } from "node:child_process";
import { join, win32 } from "node:path";
import { DEFAULT_INSTALL_ROOT } from "../../src/core/names.js";
import { HOME_ENV, defaultHome } from "../../src/core/store.js";
import { brokerTransport } from "../../src/host/broker-transport.js";
import { SIDE, runCwd, toLocal, windowsPathOf, wslPathOf } from "../../src/host/platform.js";
import { launcherApplies } from "../../src/launcher/launcher.js";

export { SIDE, runCwd, toLocal, windowsPathOf };

/** The install root, as a Windows path. */
export const ROOT_WIN = DEFAULT_INSTALL_ROOT;
/** The install root as this process opens it: `C:\aras_installations` natively, `/mnt/c/aras_installations` from WSL. */
export const ROOT_LOCAL = toLocal(ROOT_WIN);

/** The broker, as this process reaches it (the pipe natively, interop from WSL). */
export const transport = () => brokerTransport(process.env);

/**
 * The pool's state home as the CLI under test keeps it, as this process opens it: `ARASHOUSE_HOME` when set; natively
 * `%LOCALAPPDATA%\arashouse`; from WSL through the launcher, that same Windows folder through its mount.
 */
export function poolHome(env: NodeJS.ProcessEnv = process.env): string {
  const given = env[HOME_ENV]?.trim();
  if (given) return given;
  if (SIDE === "windows") return defaultHome(env);
  if (launcherApplies(env)) {
    const local = execFileSync("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], { encoding: "utf8", cwd: runCwd() }).trim();
    return wslPathOf(win32.join(local, "arashouse"));
  }
  return defaultHome(env);
}

/** Where a user's `.wslconfig` is, from this side (`%USERPROFILE%` natively, through its mount from WSL). */
export function wslConfigPath(windowsProfile: string): string {
  return join(toLocal(windowsProfile), ".wslconfig");
}
