// The broker's SQL login as it reads itself, for `hostInfo`. SQL Server's TCP protocol is off on the
// host, so the broker reaches SQL through PowerShell and `System.Data.SqlClient` on shared memory
// (`Data Source=lpc:.`) with Windows authentication as the broker's own account (ticket 22 creates
// its login). The script is a fixed string: no name, path or credential from anyone goes into it.
// It asks only about the login itself: its name, whether it is in `sysadmin` or `dbcreator` (through
// any group too, since it reads its own token), and how many `arashouse_admin` procedures it may execute;
// and one instance setting `doctor` gives advice on, `max server memory (MB)` (read only, ticket 55).

import { execFile } from "node:child_process";
import { UTILITY_DATABASE } from "../core/names.js";
import { ADMIN_PROCEDURES, sqlString } from "../core/setup-sql.js";
import { psQuote } from "../core/setup-host.js";
import type { SqlLoginInfo } from "../host/driver.js";

const PROBE_TIMEOUT_MS = 15_000;

const QUERY =
  "SELECT CONCAT(N'ok|', SUSER_SNAME(), N'|', IS_SRVROLEMEMBER('sysadmin'), N'|', IS_SRVROLEMEMBER('dbcreator'), N'|', " +
  ADMIN_PROCEDURES.map((p) => `ISNULL(HAS_PERMS_BY_NAME(${sqlString(`${UTILITY_DATABASE}.dbo.${p}`)}, N'OBJECT', N'EXECUTE'), 0)`).join(" + ") +
  ", N'|', (SELECT CAST(value_in_use AS bigint) FROM sys.configurations WHERE name = N'max server memory (MB)'))";

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$c = New-Object System.Data.SqlClient.SqlConnection 'Data Source=lpc:.;Initial Catalog=master;Integrated Security=SSPI;Connect Timeout=5;Pooling=False'",
  `try { $c.Open(); $q = $c.CreateCommand(); $q.CommandText = ${psQuote(QUERY)}; [string]$q.ExecuteScalar() } finally { $c.Dispose() }`,
].join("; ");

// The last field is empty when the login cannot see the setting.
const ANSWER = /^ok\|([^|\r\n]+)\|([01])\|([01])\|(\d+)\|(\d*)$/;

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
export function parseSqlProbe(stdout: string): SqlLoginInfo | null {
  const m = ANSWER.exec(stdout.trim());
  if (!m) return null;
  const info: SqlLoginInfo = { login: m[1] as string, sysadmin: m[2] === "1", dbcreator: m[3] === "1", procedures: Number(m[4]) };
  return m[5] ? { ...info, maxServerMemoryMb: Number(m[5]) } : info;
}

/** A probe that runs the fixed script once per call; null on any failure, never a throw. */
export function powershellSqlProbe(run: RunFile = runFile): () => Promise<SqlLoginInfo | null> {
  return async () => {
    try {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      return parseSqlProbe(stdout);
    } catch {
      return null;
    }
  };
}
