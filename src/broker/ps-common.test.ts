import { describe, expect, it } from "vitest";
import { PS_IIS } from "./ps-common.js";

describe("Get-Iis", () => {
  it("names who is running and whether it is an administrator, instead of telling the service to run elevated", () => {
    expect(PS_IIS).not.toContain("run elevated");
    expect(PS_IIS).toContain("[Security.Principal.WindowsIdentity]::GetCurrent()");
    expect(PS_IIS).toContain("IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
    expect(PS_IIS).toContain("applicationHost.config opens");
    expect(PS_IIS).toContain("docs/runbook.md");
  });

  it("keeps a caught exception's message instead of swallowing it", () => {
    expect(PS_IIS).toContain("catch { $caught = $_.Exception.Message }");
    expect(PS_IIS).toContain("error: $caught");
    expect(PS_IIS).not.toMatch(/catch \{ \}\s*\n\s*if \(-not \$readable\)/);
  });

  it("counts the pools after dropping nulls, since @($null).Count is 1", () => {
    expect(PS_IIS).toContain("@($mgr.ApplicationPools | Where-Object { $_ }).Count -gt 0");
    expect(PS_IIS).not.toContain("@($mgr.ApplicationPools).Count");
  });

  it("opens applicationHost.config without reading its content, and changes nothing", () => {
    expect(PS_IIS).toContain("[IO.File]::Open(");
    expect(PS_IIS).not.toMatch(/Get-Content|ReadAll|net\.exe|localgroup|Add-LocalGroupMember/i);
  });
});
