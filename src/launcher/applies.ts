// Whether `arashouse` in this process is the WSL launcher (src/launcher/launcher.ts) or the CLI itself. Light on
// purpose: the entry decides this before it loads either, so a launch does not pay for loading the whole CLI here.

import { existsSync } from "node:fs";
import { DEFAULT_WINDOWS_NODE, SIDE, WINDOWS_NODE_ENV, type Side } from "../host/platform.js";

/** `always`: launch the Windows build for the fake host too (the launcher's own tests, with a state on a Windows drive). */
export const LAUNCHER_ENV = "ARASHOUSE_LAUNCHER";

/** The Windows `node.exe` the launcher starts, as a WSL path. */
export function windowsNode(env: NodeJS.ProcessEnv): string {
  return env[WINDOWS_NODE_ENV]?.trim() || DEFAULT_WINDOWS_NODE;
}

/**
 * Whether `arashouse` in this process is the launcher: in WSL, with a Windows Node to run, for every host but the fake
 * one. A WSL with no Windows Node runs the CLI here, where nothing on Windows could be reached anyway.
 */
export function launcherApplies(env: NodeJS.ProcessEnv, side: Side = SIDE, exists: (path: string) => boolean = existsSync): boolean {
  if (side !== "wsl" || !exists(windowsNode(env))) return false;
  return env.ARASHOUSE_HOST !== "fake" || env[LAUNCHER_ENV] === "always";
}
