import { describe, expect, it } from "vitest";
import { powershellSqlProbe, type RunFile } from "./sql-probe.js";

describe("powershellSqlProbe", () => {
  it("runs one fixed PowerShell script over shared memory and is true only on its 'ok'", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run =
      (stdout: string | Error): RunFile =>
      async (file, args) => {
        calls.push({ file, args });
        if (stdout instanceof Error) throw stdout;
        return { stdout };
      };
    expect(await powershellSqlProbe(run("ok\r\n"))()).toBe(true);
    expect(await powershellSqlProbe(run(""))()).toBe(false);
    expect(await powershellSqlProbe(run(new Error("Login failed")))()).toBe(false);
    const { file, args } = calls[0]!;
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[3]).toContain("Data Source=lpc:.");
    expect(args[3]).toContain("Integrated Security=SSPI");
    expect(args[3]).not.toMatch(/password|pwd|User ID|OLM|olm/i);
    expect(new Set(calls.map((c) => c.args[3])).size).toBe(1);
  });
});
