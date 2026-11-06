import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { powershellAdminProbe } from "../src/broker/admin-probe.js";
import { PS_IIS } from "../src/broker/ps-common.js";
import { redact } from "../src/core/redact.js";

function findPowerShell(): string | undefined {
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
  return probe.status === 0 ? "powershell.exe" : undefined;
}
const ps = findPowerShell();
const describeWithPs = ps ? describe : describe.skip;

function runPs(script: string): { out: string; code: number | null } {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const r = spawnSync(ps as string, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined,
  });
  return { out: r.stdout, code: r.status };
}

// A stand-in for IIS's assembly, in a temp folder that `$env:windir` points at inside the one PowerShell process of a
// case: real IIS and the real applicationHost.config are never opened, and no host setting changes.
const SETUP = String.raw`
$ErrorActionPreference = 'Stop'
$base = Join-Path ([IO.Path]::GetTempPath()) ('arashouse-get-iis-' + [guid]::NewGuid().ToString('N'))
$plain = Join-Path $base 'plain\System32\inetsrv'
$withConfig = Join-Path $base 'config\System32\inetsrv'
New-Item -ItemType Directory -Force -Path $plain, (Join-Path $withConfig 'config') | Out-Null
Add-Type -OutputAssembly (Join-Path $plain 'Microsoft.Web.Administration.dll') -TypeDefinition @'
namespace Microsoft.Web.Administration {
  public class ServerManager : System.IDisposable {
    static string Mode { get { return System.Environment.GetEnvironmentVariable("STUB_IIS"); } }
    public object Sites { get {
      if (Mode == "throws") throw new System.InvalidOperationException("stub read failure\r\nLine number: 7\r\n\r\nError: stub detail\r\n");
      return Mode == "null-sites" ? null : new object[0];
    } }
    public object ApplicationPools { get {
      if (Mode == "null-pools" || Mode == "null-sites") return null;
      return Mode == "readable" ? new object[] { new object() } : new object[0];
    } }
    public void Dispose() { }
  }
}
'@
Copy-Item (Join-Path $plain 'Microsoft.Web.Administration.dll') $withConfig
Set-Content -LiteralPath (Join-Path $withConfig 'config\applicationHost.config') -Value '<configuration />'
$base
`;

describeWithPs("Get-Iis under Windows PowerShell", { timeout: 120_000 }, () => {
  let base = "";
  let identity = "";
  let administrator = "";

  beforeAll(() => {
    const made = runPs(SETUP);
    expect(made.code).toBe(0);
    base = made.out.trim();
    const me = runPs(
      "$id = [Security.Principal.WindowsIdentity]::GetCurrent(); $id.Name; (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    );
    const [name, admin] = me.out.split(/\r?\n/);
    identity = name as string;
    administrator = admin === "True" ? "yes" : "no";
  }, 120_000);

  afterAll(() => {
    if (base) runPs(`Remove-Item -LiteralPath '${base}' -Recurse -Force -ErrorAction SilentlyContinue`);
  });

  function getIis(mode: string, windir: "plain" | "config" = "plain"): { out: string; code: number | null } {
    return runPs(
      [
        "$ErrorActionPreference = 'Stop'",
        `$env:STUB_IIS = '${mode}'`,
        `$env:windir = '${base}\\${windir}'`,
        "function Stop-Step([string]$Message) { [Console]::Out.WriteLine(\"REFUSED: $Message\"); exit 7 }",
        PS_IIS,
        "$mgr = Get-Iis",
        "'READABLE ' + $mgr.GetType().FullName",
      ].join("\n"),
    );
  }

  it("refuses a configuration that reads Sites as null, saying who runs, with what token, and that the file does not open", () => {
    const r = getIis("null-sites");
    expect(r.code).toBe(7);
    expect(r.out).toContain(`the IIS configuration is not readable: running as ${identity}; is an administrator: ${administrator}; applicationHost.config opens: no`);
    expect(r.out).toContain("The IIS configuration is not readable");
    expect(r.out).not.toContain("run elevated");
    expect(redact(r.out)).toContain(`is an administrator: ${administrator}; applicationHost.config opens: no`);
    expect(redact(r.out)).not.toContain("[redacted]");
    expect(r.out).not.toContain("error:");
  });

  it("says that the file opens when it does", () => {
    const r = getIis("null-sites", "config");
    expect(r.code).toBe(7);
    expect(r.out).toContain("applicationHost.config opens: yes");
  });

  it("carries the exception a read threw", () => {
    const r = getIis("throws");
    expect(r.code).toBe(7);
    expect(r.out).toContain("; error: ");
    expect(r.out).toContain("stub read failure Line number: 7 Error: stub detail");
    expect(r.out.trim().split(/\r?\n/)).toHaveLength(1);
    expect(r.out).toContain(`is an administrator: ${administrator}`);
  });

  it.each(["empty-pools", "null-pools"])("refuses when there are no pools: %s", (mode) => {
    const r = getIis(mode);
    expect(r.code).toBe(7);
    expect(r.out).toContain("the IIS configuration is not readable: running as");
  });

  it("hands back the manager of a configuration that reads", () => {
    const r = getIis("readable");
    expect(r.code).toBe(0);
    expect(r.out).toContain("READABLE Microsoft.Web.Administration.ServerManager");
  });

  it("the broker's token probe reports this process's account and token", async () => {
    expect(await powershellAdminProbe()()).toEqual({ isAdministrator: administrator === "yes", identity });
  });
});
