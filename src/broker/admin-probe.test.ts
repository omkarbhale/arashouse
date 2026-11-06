import { describe, expect, it } from "vitest";
import { parseAdminProbe, powershellAdminProbe, type RunFile } from "./admin-probe.js";

describe("powershellAdminProbe", () => {
  it("runs one fixed script that reads only the process's own token", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run =
      (stdout: string | Error): RunFile =>
      async (file, args) => {
        calls.push({ file, args });
        if (stdout instanceof Error) throw stdout;
        return { stdout };
      };
    expect(await powershellAdminProbe(run("ok|0|NT SERVICE\\ArasHouseBroker\r\n"))()).toEqual({ isAdministrator: false, identity: "NT SERVICE\\ArasHouseBroker" });
    expect(await powershellAdminProbe(run("ok|1|NT SERVICE\\ArasHouseBroker\r\n"))()).toEqual({ isAdministrator: true, identity: "NT SERVICE\\ArasHouseBroker" });
    expect(await powershellAdminProbe(run(""))()).toBeNull();
    expect(await powershellAdminProbe(run(new Error("timed out")))()).toBeNull();
    const { file, args } = calls[0]!;
    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[3]).toContain("WindowsIdentity]::GetCurrent()");
    expect(args[3]).toContain("IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
    expect(args[3]).not.toMatch(/net\.exe|localgroup|\/add|Add-LocalGroupMember|password|pwd/i);
    expect(new Set(calls.map((c) => c.args[3])).size).toBe(1);
  });

  it("takes only a whole answer", () => {
    expect(parseAdminProbe("ok|1|SG\\omkarb")).toEqual({ isAdministrator: true, identity: "SG\\omkarb" });
    for (const bad of ["", "ok|2|x", "ok|1|", "ok|1", "x|1|y", "ok|1|a|b"]) expect(parseAdminProbe(bad)).toBeNull();
  });
});
