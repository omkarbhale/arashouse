import { describe, expect, it } from "vitest";
import { MSI_BUILT_IN_PROPERTIES, MSI_CUSTOM_ACTION_PROPERTIES, baselinePlan, compareDenyList, msiInstallProperties } from "./baseline.js";
import { renderBaselineBuildScript } from "./baseline-script.js";
import { GuardError, assertOwned } from "./guards.js";
import { buildScratch, goldenLayout } from "./names.js";

const SHA = "e".repeat(64);

describe("the baseline plan", () => {
  it("derives every name and path from the flavor", () => {
    const plan = baselinePlan("12sp9", { msiSha256: SHA });
    expect(plan.names).toMatchObject({ alias: "ah-build-12sp9", database: "arashouse_build_12sp9", dir: "C:\\aras_installations\\golden-build\\12sp9" });
    expect(plan.scratch).toEqual({
      logins: { dbo: "arashouse_build_12sp9_dbo", reg: "arashouse_build_12sp9_reg" },
      poolPrefix: "ah-build-12sp9-",
      msiDir: "C:\\aras_installations\\golden-build\\12sp9.msi",
      vaultRoot: "C:\\aras_installations\\golden-build\\12sp9.vault",
      candidateDir: "C:\\aras_installations\\golden-build\\12sp9.golden",
      retiredDir: "C:\\aras_installations\\golden-build\\12sp9.old",
      promotingMarker: "C:\\aras_installations\\golden-build\\12sp9.promoting",
      engineDir: "C:\\aras_installations\\golden-build\\12sp9.engine",
      bundleDir: "C:\\aras_installations\\staging\\baseline-12sp9",
      agent: { folder: "ah-build-12sp9", service: "ArasInnovatorAgent_ah-build-12sp9", port: 8800, address: "http://localhost:8800/ah-build-12sp9" },
    });
    expect(buildScratch("23").agent).toEqual({ folder: "ah-build-23", service: "ArasInnovatorAgent_ah-build-23", port: 8900, address: "http://localhost:8900/" });
    expect(buildScratch("35").agent.port).toBe(9000);
    expect(plan.databaseFiles).toEqual({ data: "C:\\aras_installations\\sqldata\\arashouse_build_12sp9.mdf", log: "C:\\aras_installations\\sqldata\\arashouse_build_12sp9_log.ldf" });
    expect(plan.golden).toEqual(goldenLayout("12sp9"));
    expect(plan.golden.tree).toBe("C:\\aras_installations\\golden\\12sp9\\tree");
    expect(plan.candidate.tree).toBe("C:\\aras_installations\\golden-build\\12sp9.golden\\tree");
    expect(plan.media.coreAndSolutions).toBe("C:\\aras_installations\\staging\\baseline-12sp9\\media\\CoreAndSolutions120.bak");
    expect(plan.serverBuild).toBe("12.0.0.24090");
    expect(plan.replace).toBe(false);
    expect(plan.libsJsEngine).toBe("12.0");
    expect(baselinePlan("23", { msiSha256: SHA }).libsJsEngine).toBe("14.0.7");
    expect(() => baselinePlan("12sp9", { msiSha256: "nope" })).toThrow(/SHA-256/);
    expect(() => baselinePlan("olm" as never, { msiSha256: SHA })).toThrow(/unknown flavor/);
  });

  it("passes every path and name the guards admit, and the deny-list refuses none of them", () => {
    for (const flavor of ["12sp9", "23", "35"] as const) {
      const plan = baselinePlan(flavor, { msiSha256: SHA });
      for (const path of [plan.names.dir, plan.scratch.msiDir, plan.scratch.vaultRoot, plan.scratch.candidateDir, plan.scratch.retiredDir, plan.scratch.bundleDir, plan.golden.tree, plan.backupScratch, plan.candidate.ootbBackup]) {
        expect(assertOwned("path", path), path).toBe(path);
      }
      expect(assertOwned("alias", plan.names.alias)).toBe(plan.names.alias);
      expect(assertOwned("database", plan.names.database)).toBe(plan.names.database);
      for (const login of Object.values(plan.scratch.logins)) expect(assertOwned("login", login)).toBe(login);
      expect(assertOwned("appPool", `${plan.scratch.poolPrefix}root`)).toBe(`${plan.scratch.poolPrefix}root`);
    }
  });

  it("admits golden-build\\<key> and its scratch folders only", () => {
    const refused = (path: string) => {
      try {
        assertOwned("path", path);
        return false;
      } catch (err) {
        return err instanceof GuardError;
      }
    };
    expect(refused("C:\\aras_installations\\golden-build\\12sp9\\Innovator\\Server")).toBe(false);
    expect(refused("C:\\aras_installations\\golden-build\\23.golden\\tree")).toBe(false);
    for (const bad of ["C:\\aras_installations\\golden-build", "C:\\aras_installations\\golden-build\\olm", "C:\\aras_installations\\golden-build\\12sp9.tmp", "C:\\aras_installations\\golden-build\\12sp9.a.msi"]) {
      expect(refused(bad), bad).toBe(true);
    }
    expect(() => assertOwned("path", "C:\\aras_installations\\golden-build\\12sp9", { flavor: "12sp9", slot: 1 })).toThrow(/different slot/);
  });

  it("installs unattended with INSTALLDIR and VAULT_ROOT always set, no database, its own agent and no restart", () => {
    const props = msiInstallProperties(baselinePlan("23", { msiSha256: SHA }));
    expect(props).toEqual({
      INSTALLDIR: "C:\\aras_installations\\golden-build\\23",
      VAULT_ROOT: "C:\\aras_installations\\golden-build\\23.vault",
      WEBALIAS: "ah-build-23",
      INSTALL_DATABASE: "0",
      INSTALL_AGENT_SERVICE: "1",
      AS_FOLDER: "ah-build-23",
      AS_HOST: "localhost",
      AS_PORT: "8900",
      INNOVATOR_TO_SERVICE_ADDRESS: "http://localhost:8900/",
      ARAS_AGENTSERVICE_TO_INNOVATORSERVER_URL: "http://localhost/ah-build-23/Server/InnovatorServer.aspx",
      IS_SQLSERVER_SERVER: "(local)",
      IS_SQLSERVER_DATABASE: "arashouse_build_23",
      IS_SQLSERVER_AUTHENTICATION: "0",
      SQL_SERVER_LOGIN_NAME: "arashouse_build_23_dbo",
      SQL_SERVER_LOGIN_REGULAR_NAME: "arashouse_build_23_reg",
      REBOOT: "ReallySuppress",
      MSIRESTARTMANAGERCONTROL: "Disable",
    });
    expect(Object.keys(props).filter((k) => /PASSWORD|LICENSE/.test(k))).toEqual([]);
    expect(MSI_BUILT_IN_PROPERTIES).toEqual(["INSTALLDIR", "VAULT_ROOT", "REBOOT", "MSIRESTARTMANAGERCONTROL"]);
    expect(MSI_CUSTOM_ACTION_PROPERTIES).toEqual(["INNOVATOR_TO_SERVICE_ADDRESS"]);
    // 12.0's agent takes its URL path from AS_FOLDER; never the MSI's default, which the captain's installs may use.
    const p12 = msiInstallProperties(baselinePlan("12sp9", { msiSha256: SHA }));
    expect(p12).toMatchObject({ AS_FOLDER: "ah-build-12sp9", AS_PORT: "8800", INNOVATOR_TO_SERVICE_ADDRESS: "http://localhost:8800/ah-build-12sp9" });
    for (const flavor of ["12sp9", "23", "35"] as const) {
      const p = msiInstallProperties(baselinePlan(flavor, { msiSha256: SHA }));
      expect(p.AS_FOLDER).not.toMatch(/^ArasInnovatorAgent$/i);
      expect(["8734", "8735", "8736"]).not.toContain(p.AS_PORT);
    }
  });
});

describe("the deny-list self-check", () => {
  it("names what changed, went or appeared, and nothing else", () => {
    expect(compareDenyList({ a: "1", b: "2" }, { a: "1", b: "2" })).toEqual({ ok: true, changed: [], missing: [], added: [] });
    expect(compareDenyList({ a: "1", b: "2", c: "3" }, { a: "9", c: "3", d: "4" })).toEqual({ ok: false, changed: ["a"], missing: ["b"], added: ["d"] });
  });
});

describe("baseline-build.ps1", () => {
  const pinned = [
    { path: "app\\broker\\baseline-main.js", sha256: "1".repeat(64) },
    { path: "package.json", sha256: "2".repeat(64) },
    { path: "plan.json", sha256: "3".repeat(64) },
    { path: "baseline-steps.ps1", sha256: "4".repeat(64) },
    { path: "media\\InnovatorSetup.msi", sha256: "5".repeat(64) },
  ];

  it("pins every file it runs, refuses to run elsewhere, and needs -Apply and elevation to change anything", () => {
    const script = renderBaselineBuildScript({ flavor: "12sp9", version: "0.0.0", pinned });
    expect(script).toMatch(/^[\x00-\x7f]*$/);
    for (const p of pinned) expect(script).toContain(`@{ path = '${p.path}'; sha256 = '${p.sha256}' }`);
    expect(script).toContain("$Bundle = 'C:\\aras_installations\\staging\\baseline-12sp9'");
    expect(script).toContain("if (-not $Apply) {");
    expect(script.indexOf("if (-not $Apply)")).toBeLessThan(script.indexOf("IsInRole"));
    expect(script.indexOf("Stop-Build 3")).toBeLessThan(script.indexOf("if (-not $Apply)"));
    expect(script).not.toMatch(/Program Files[^']*\\(Aras|nodejs)[^']*'\s*\)?\s*(-Force|\|)/);
    // Secrets come from hidden prompts or the user's DPAPI files, and reach Node in its environment only.
    expect(script).toContain("Read-Host -AsSecureString");
    expect(script).toContain("SetEnvironmentVariable('ARASHOUSE_BUILD_LICENCE', $null, 'Process')");
    expect(script).not.toMatch(/\$nodeArgs \+= .*(licence|admin)/i);
  });

  it("pins the engine CLI's files, scoped packages included, and refuses an unpinned file under engine\\ as under app\\", () => {
    const engine = [...pinned, { path: "engine\\node_modules\\@xmldom\\xmldom\\package.json", sha256: "6".repeat(64) }];
    const script = renderBaselineBuildScript({ flavor: "23", version: "0.0.0", pinned: engine });
    expect(script).toContain("@{ path = 'engine\\node_modules\\@xmldom\\xmldom\\package.json'; sha256 = '" + "6".repeat(64) + "' }");
    expect(script).toContain("foreach ($folder in @('app', 'engine')) {");
    expect(script).toContain("libs-js engine (14.0.7)");
  });

  it("refuses a bundle path that could leave the bundle, a bad hash and a missing entry", () => {
    expect(() => renderBaselineBuildScript({ flavor: "12sp9", version: "0.0.0", pinned: [...pinned, { path: "..\\x", sha256: "1".repeat(64) }] })).toThrow(/unusable/);
    expect(() => renderBaselineBuildScript({ flavor: "12sp9", version: "0.0.0", pinned: [{ ...pinned[0]!, sha256: "x" }, ...pinned.slice(1)] })).toThrow(/64 hex/);
    expect(() => renderBaselineBuildScript({ flavor: "12sp9", version: "0.0.0", pinned: pinned.slice(1) })).toThrow(/baseline-main/);
  });

  it("names the bundle folder buildScratch derives", () => {
    expect(renderBaselineBuildScript({ flavor: "35", version: "1.0.0", pinned })).toContain(`'${buildScratch("35").bundleDir}'`);
  });
});
