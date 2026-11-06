// Whether the broker's own token is an administrator's, for `hostInfo`. A domain Group Policy ("Restricted Groups")
// can take `NT SERVICE\ArasHouseBroker` out of the local Administrators group; the service keeps the token it was
// started with, so the loss shows at the next restart, as IIS reading as empty (docs/runbook.md). `ping` still answers,
// so `doctor` asks this. The script is a fixed string and reads the token of the process it runs in: PowerShell
// started by the broker has the broker's token. It prints a flag and the account name; no secret is involved.

import { execFile } from "node:child_process";
import type { BrokerToken } from "../host/driver.js";

const PROBE_TIMEOUT_MS = 15_000;

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$id = [Security.Principal.WindowsIdentity]::GetCurrent()",
  "$admin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  "'ok|' + [int]$admin + '|' + $id.Name",
].join("; ");

const ANSWER = /^ok\|([01])\|([^|\r\n]+)$/;

export type RunFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

const runFile: RunFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
  });

/** The probe's answer, or null when it is not one. */
export function parseAdminProbe(stdout: string): BrokerToken | null {
  const m = ANSWER.exec(stdout.trim());
  return m ? { isAdministrator: m[1] === "1", identity: m[2] as string } : null;
}

/** A probe that runs the fixed script once per call; null on any failure, never a throw. */
export function powershellAdminProbe(run: RunFile = runFile): () => Promise<BrokerToken | null> {
  return async () => {
    try {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      return parseAdminProbe(stdout);
    } catch {
      return null;
    }
  };
}
