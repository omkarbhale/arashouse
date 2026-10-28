import { describe, expect, it } from "vitest";
import { ExtractPathError, PROTECTED_FILE_PATTERNS, isProtectedFile, parseSlotSubpath, stagedBackupName, stagedBackupPath } from "./extract.js";
import { FLAVOR_KEYS } from "./flavors.js";

describe("parseSlotSubpath", () => {
  it("splits a path inside the slot folder on / or \\, the whole folder being . or nothing", () => {
    expect(parseSlotSubpath("Innovator/Client/javascript")).toEqual(["Innovator", "Client", "javascript"]);
    expect(parseSlotSubpath("Innovator\\Server\\bin\\x.dll")).toEqual(["Innovator", "Server", "bin", "x.dll"]);
    expect(parseSlotSubpath("./Innovator//Client/")).toEqual(["Innovator", "Client"]);
    expect(parseSlotSubpath(".")).toEqual([]);
    expect(parseSlotSubpath("")).toEqual([]);
  });

  it("refuses an absolute path, a drive, a UNC path, .. and a name Windows does not allow", () => {
    for (const bad of ["/etc/passwd", "\\Windows", "C:\\Windows", "c:x", "\\\\server\\share", "..", "Innovator/../../23", "a/..", "a:b", "x\u0000y", "trailing.", "space ", "a|b", "a*"]) {
      expect(() => parseSlotSubpath(bad), JSON.stringify(bad)).toThrow(ExtractPathError);
    }
  });
});

describe("isProtectedFile", () => {
  it("covers ticket 40's protected list, by name and in any folder, in any case", () => {
    expect(PROTECTED_FILE_PATTERNS).toEqual(["InnovatorServerConfig.xml", "*.pfx", "*.cer", "key-*.xml", "vault.config"]);
    for (const flavor of FLAVOR_KEYS) {
      for (const path of ["InnovatorServerConfig.xml", "innovatorserverconfig.XML", "OAuthServer/App_Data/Certificates/OAuth.pfx", "x/y.CER", "OAuthServer/App_Data/key-abc.xml", "VaultServer/vault.config"]) {
        expect(isProtectedFile(flavor, path), `${flavor} ${path}`).toBe(true);
      }
      for (const path of ["Innovator/Client/javascript/x.js", "Innovator/Server/bin/IOM.dll", "keys.xml", "vault.config.bak", "Innovator/Server/web.config"]) {
        expect(isProtectedFile(flavor, path), `${flavor} ${path}`).toBe(false);
      }
    }
  });

  it("covers every file the flavor's edit list writes a secret into", () => {
    expect(isProtectedFile("12sp9", "SelfServiceReportConfig.xml")).toBe(true);
    expect(isProtectedFile("12sp9", "selfservicereportconfig.xml")).toBe(true);
    expect(isProtectedFile("12sp9", "Innovator/SelfServiceReportConfig.xml")).toBe(false);
  });
});

describe("the staged backup", () => {
  it("is a new .bak inside staging\\<lease_id>", () => {
    expect(stagedBackupName(() => "0a1b2c3d")).toBe("extract-db-0a1b2c3d.bak");
    expect(stagedBackupName()).toMatch(/^extract-db-[0-9a-f]{8}\.bak$/);
    expect(stagedBackupPath("0".repeat(32), "extract-db-1.bak")).toBe(`C:\\aras_installations\\staging\\${"0".repeat(32)}\\extract-db-1.bak`);
  });
});
