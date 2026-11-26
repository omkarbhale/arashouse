// Who besides the worker user can open the state home, for `doctor` (the home holds the lease passwords). On Windows
// a mode says nothing: the home's ACL does, read by SID so a localised name cannot fool the check. The worker user,
// SYSTEM, the administrators and CREATOR OWNER (an inherit-only entry for what the owner creates) are expected; any
// other identity the ACL allows is named. Elsewhere it is the mode: group or others with any access.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { powershellEnv } from "../host/platform.js";

const execFileAsync = promisify(execFile);

/** The SIDs a home under the worker user's profile is open to besides the user: SYSTEM, Administrators, CREATOR OWNER. */
export const EXPECTED_SIDS = ["S-1-5-18", "S-1-5-32-544", "S-1-3-0"] as const;

/** The PowerShell that prints, one per line, every identity `path`'s ACL allows besides the user and `EXPECTED_SIDS`. */
export function homeAclScript(path: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = '${path.replace(/'/g, "''")}'`,
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `$expected = @($me, ${EXPECTED_SIDS.map((s) => `'${s}'`).join(", ")})`,
    "$others = @()",
    "foreach ($rule in (Get-Acl -LiteralPath $path).Access) {",
    "  if ($rule.AccessControlType -ne 'Allow') { continue }",
    "  try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $sid = $rule.IdentityReference.Value }",
    "  if ($expected -notcontains $sid) { $others += $rule.IdentityReference.Value }",
    "}",
    "$others | Sort-Object -Unique",
  ].join("\n");
}

export type RunPowerShell = (script: string) => Promise<string>;

const runPowerShell: RunPowerShell = async (script) =>
  (
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 60_000, windowsHide: true, env: powershellEnv() },
    )
  ).stdout;

/** The identities besides the worker user that can open `home`; none for a home not made yet (the first `get` makes it). */
export async function homeAccess(
  home: string,
  options: { readonly platform?: NodeJS.Platform; readonly run?: RunPowerShell } = {},
): Promise<{ readonly home: string; readonly others: readonly string[]; readonly missing?: boolean }> {
  if (!existsSync(home)) return { home, others: [], missing: true };
  if ((options.platform ?? process.platform) === "win32") {
    const out = await (options.run ?? runPowerShell)(homeAclScript(home));
    return { home, others: out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
  }
  const mode = (await stat(home)).mode & 0o777;
  return { home, others: (mode & 0o077) === 0 ? [] : [`its group or others (mode ${mode.toString(8).padStart(4, "0")})`] };
}
