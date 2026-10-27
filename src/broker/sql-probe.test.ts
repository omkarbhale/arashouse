import { describe, expect, it } from "vitest";
import { parseSqlProbe, powershellSqlProbe, type RunFile } from "./sql-probe.js";

describe("powershellSqlProbe", () => {
  it("runs one fixed PowerShell script over shared memory and reads the login's own roles back", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run =
      (stdout: string | Error): RunFile =>
      async (file, args) => {
        calls.push({ file, args });
        if (stdout instanceof Error) throw stdout;
        return { stdout };
      };
    expect(await powershellSqlProbe(run("ok|NT SERVICE\\ArasHouseBroker|0|0|5\r\n"))()).toEqual({
      login: "NT SERVICE\\ArasHouseBroker",
      sysadmin: false,
      dbcreator: false,
      procedures: 5,
    });
    expect(await powershellSqlProbe(run(""))()).toBeNull();
    expect(await powershellSqlProbe(run(new Error("Login failed")))()).toBeNull();
    const { file, args } = calls[0]!;
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[3]).toContain("Data Source=lpc:.");
    expect(args[3]).toContain("Integrated Security=SSPI");
    expect(args[3]).toContain("IS_SRVROLEMEMBER(''sysadmin'')");
    expect(args[3]).toContain("IS_SRVROLEMEMBER(''dbcreator'')");
    expect(args[3]).toContain("arashouse_admin.dbo.kill_connections");
    expect(args[3]).not.toMatch(/password|pwd|User ID|OLM|olm|sys\.databases/i);
    expect(new Set(calls.map((c) => c.args[3])).size).toBe(1);
  });

  it("takes only a whole answer", () => {
    expect(parseSqlProbe("ok|SG\\omkarb|1|1|0")).toEqual({ login: "SG\\omkarb", sysadmin: true, dbcreator: true, procedures: 0 });
    for (const bad of ["ok|x|2|0|5", "ok|x|0|0", "ok||0|0|5", "x|0|0|5", "ok|x|0|0|5|extra", "ok|x|0|0|-1"]) expect(parseSqlProbe(bad)).toBeNull();
  });
});
