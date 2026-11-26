// The PowerShell the host-script tests run, and the paths they hand it. The tests run either from WSL, where Linux node
// starts Windows PowerShell through interop and a local path needs `wslpath -w`, or natively under Windows node, where a
// local path is already a Windows path. On a Linux machine without Windows PowerShell the suites that need it skip.

import { powershellEnv } from "../src/host/platform.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe } from "vitest";

const native = process.platform === "win32";

/** SPIKE_POWERSHELL, else Windows PowerShell 5.1 (`powershell.exe`, from WSL or natively); undefined when neither starts. */
function findPowerShell(): string | undefined {
  const candidates = [process.env.SPIKE_POWERSHELL, "powershell.exe"].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const probe = spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
    if (probe.status === 0) return c;
  }
  return undefined;
}

export const ps = findPowerShell();

/** True when `ps` runs on the Windows host: any PowerShell natively, or a Windows executable from WSL (a Linux pwsh is not). */
export const onWindowsHost = ps !== undefined && (native || ps.toLowerCase().endsWith(".exe"));

/** The path `ps` opens for a local path: from WSL, `wslpath -w` of it; natively (or for a Linux pwsh), the path itself. */
export function toHostPath(localPath: string): string {
  return onWindowsHost && !native ? execFileSync("wslpath", ["-w", localPath], { encoding: "utf8" }).trim() : localPath;
}

/** The path this process opens for a Windows drive path: natively the path itself, from WSL `/mnt/<d>/...`. */
export function toLocalPath(windowsPath: string): string {
  if (native) return windowsPath;
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(windowsPath);
  if (!m) throw new Error(`${windowsPath} is not a Windows drive path`);
  const rest = (m[2] ?? "").split(/[\\/]/).filter(Boolean).join("/");
  return `/mnt/${(m[1] as string).toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** Whether a Windows drive path exists on the host, read from this side. */
export const hostPathExists = (windowsPath: string): boolean => existsSync(toLocalPath(windowsPath));

/** A WSL cwd reaches powershell.exe as a UNC path, which Windows PowerShell dislikes, so from WSL start on the C: drive; natively, the cwd as it is. */
export const psCwd = onWindowsHost && !native && existsSync("/mnt/c") ? "/mnt/c" : undefined;

/** Runs on the host when a PowerShell is at hand, and skips otherwise. */
export const describeWithPs = ps ? describe : describe.skip;

/** Runs only when the PowerShell runs on the Windows host (not a Linux pwsh), and skips otherwise. */
export const describeOnWindowsHost = onWindowsHost ? describe : describe.skip;

export interface PsRun {
  code: number | null;
  out: string;
  err: string;
}

export interface PsOptions {
  /** Milliseconds before the run is killed (120 s when not given). */
  timeout?: number;
  /** Text written to the run's stdin. */
  input?: string;
}

/** Runs `ps -NoProfile -NonInteractive -ExecutionPolicy Bypass <args>`; the caller converts any path in `args` with `toHostPath`. */
export function runPs(args: readonly string[], options: PsOptions = {}): PsRun {
  const r = spawnSync(ps as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
    encoding: "utf8",
    cwd: psCwd,
    // Started from PowerShell 7 (a Windows CI runner's shell), the inherited PSModulePath would break 5.1's modules.
    env: powershellEnv(),
    timeout: options.timeout ?? 120_000,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Runs the script at the local path `file` with `-File`, followed by `args`. */
export function runPsFile(file: string, args: readonly string[] = [], options: PsOptions = {}): PsRun {
  return runPs(["-File", toHostPath(file), ...args], options);
}

let elevatedAnswer: boolean | undefined;

/**
 * Whether `ps` runs elevated (an administrator's full token), asked once. A test that checks a script refuses to run
 * unelevated skips when it is: an elevated runner (a Windows CI image) would let the script go on to read or change the host.
 */
export function elevated(): boolean {
  if (!onWindowsHost) return false;
  elevatedAnswer ??=
    runPs(["-Command", "(New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"]).out.trim() ===
    "True";
  return elevatedAnswer;
}
