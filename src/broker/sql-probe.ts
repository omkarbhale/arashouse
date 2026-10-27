// Whether the broker's SQL login connects, for `hostInfo`. SQL Server's TCP protocol is off on the
// host, so the broker reaches SQL through PowerShell and `System.Data.SqlClient` on shared memory
// (`Data Source=lpc:.`) with Windows authentication as the broker's own account (ticket 22 creates
// its login). The script is a fixed string: no name, path or credential from anyone goes into it.

import { execFile } from "node:child_process";

const PROBE_TIMEOUT_MS = 15_000;

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$c = New-Object System.Data.SqlClient.SqlConnection 'Data Source=lpc:.;Initial Catalog=master;Integrated Security=SSPI;Connect Timeout=5'",
  "try { $c.Open(); $q = $c.CreateCommand(); $q.CommandText = 'SELECT 1'; [void]$q.ExecuteScalar(); 'ok' } finally { $c.Dispose() }",
].join("; ");

export type RunFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

const runFile: RunFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
  });

/** A probe that runs the fixed script once per call; false on any failure, never a throw. */
export function powershellSqlProbe(run: RunFile = runFile): () => Promise<boolean> {
  return async () => {
    try {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      return stdout.trim() === "ok";
    } catch {
      return false;
    }
  };
}
