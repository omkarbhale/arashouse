import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";
import { describeWithPs, ps, runPs, runPsFile, toHostPath } from "./powershell.js";

const spikeDir = join(repoRoot, "spike");
const scripts = readdirSync(spikeDir)
  .filter((f) => /^\d\d-.*\.ps1$/.test(f))
  .sort();
const libFiles = readdirSync(join(spikeDir, "lib")).map((f) => `lib/${f}`);

const run = runPsFile;

const spikeScript = (name: string) => join(spikeDir, name);

describe("spike scripts (static)", () => {
  it("has the eight scripts of the ticket, the folder initialiser and the product-code step", () => {
    expect(scripts).toEqual([
      "00-preflight.ps1",
      "01-init-folders.ps1",
      "09-new-product-code.ps1",
      "10-baseline-install.ps1",
      "20-clone-slot.ps1",
      "30-licence-reuse.ps1",
      "40-measure.ps1",
      "50-quiesce.ps1",
      "60-sql-restore-owner.ps1",
      "90-teardown.ps1",
    ]);
  });

  it("is plain ASCII, so Windows PowerShell 5.1 reads it without a BOM", () => {
    for (const f of [...scripts, ...libFiles, "README.md"]) {
      const text = readFileSync(join(spikeDir, f), "utf8");
      expect(text, f).toMatch(/^[\x00-\x7f]*$/);
    }
  });

  it("has a sitting order in spike/README.md that names every script", () => {
    const readme = readFileSync(join(spikeDir, "README.md"), "utf8");
    for (const f of scripts) expect(readme, f).toContain(f);
    expect(readme).toMatch(/Sitting order/);
  });
});

// Each run starts Windows PowerShell (about 1 to 5 s).
describeWithPs(`spike scripts under ${ps}`, { timeout: 60_000 }, () => {
  it("parse without a syntax error", () => {
    const files = [...scripts, ...libFiles].map((f) => toHostPath(join(spikeDir, f)));
    expect(runPsFile(join(repoRoot, "test/spike-parse.ps1"), files).out.trim()).toBe("errors=0");
  });

  // 00-preflight reads the Windows registry and prints the inventory even in a dry run, so it is not in this list.
  const dryRunnable = scripts.filter((s) => s !== "00-preflight.ps1");

  it.each(dryRunnable)("%s dry run prints only 'would do' lines and exits 0", (script) => {
    const r = run(spikeScript(script));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split(/\r?\n/).filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(3);
    const offenders = lines.filter((l) => !/^(would do: |dry run: )/.test(l));
    expect(offenders).toEqual([]);
    expect(lines.filter((l) => l.startsWith("would do: ")).length).toBeGreaterThan(2);
  });

  describe("deny-list", () => {
    const dir = mkdtempSync(join(tmpdir(), "spike-cases-"));
    const caseFile = join(dir, "cases.txt");

    // Names the tool must refuse because they exist on the captain's laptop (the reason says DENY-LIST).
    const onDenyList = [
      "Database|12sp9",
      "Database|OLM_Local",
      "Database|olm_local",
      "Database|InnovatorSolutions",
      "Database|RabbitDemo1",
      "Database|InnovatorSolutions28",
      "Database|arashouse_spike_prod_a",
      "Alias|12sp9",
      "Alias|InnovatorServer",
      "Alias|InnovatorServer23",
      "Alias|innovatorserver28",
      "Pool|InnovatorServer",
      "Service|ArasInnovatorAgent_ArasInnovatorAgent12",
      "Service|ArasInnovatorAgent_x",
      "Folder|C:\\Program Files (x86)\\Aras12\\Innovator",
      "Folder|C:\\Program Files (x86)\\Aras\\Innovator\\Server",
      "Folder|C:\\Aras28",
      "ReadFolder|C:\\Program Files (x86)\\Aras12\\Innovator",
    ];
    // Names that are not on the deny-list but still fall outside the spike allowlist (the reason says ALLOWLIST or PATH).
    const outsideAllowlist = [
      "Database|master",
      "Database|arashouse_other",
      "Login|sa",
      "Alias|ah-other-a",
      "Service|W3SVC",
      "Folder|C:\\aras_installations",
      "Folder|C:\\aras_installations\\spike",
      "Folder|C:\\aras_installations\\spike\\..\\..\\Windows",
      "Folder|C:\\aras_installations\\spike-evil\\x",
      "Folder|C:\\aras_installations\\staging\\12sp9",
      "Folder|\\\\wsl.localhost\\Ubuntu\\home\\x",
      "Folder|relative\\path",
      "ReadFolder|C:\\Windows",
    ];
    const denied = [...onDenyList, ...outsideAllowlist];
    const allowed = [
      "Database|arashouse_spike_12sp9_a",
      "Database|arashouse_spike_admin",
      "Login|arashouse_spike_12sp9_b_dbo",
      "Login|arashouse_spike_pool",
      "Alias|ah-spike-12sp9-a",
      "Pool|ah-spike-12sp9-b-oauthserver",
      "Service|ArasHouseAgent_spike_12sp9_b",
      "Folder|C:\\aras_installations\\spike\\golden-build\\12sp9",
      "Folder|c:/aras_installations/spike/slot-12sp9-b",
      "ReadFolder|C:\\aras_installations\\staging\\12sp9\\cd",
      "ReadFolder|C:\\aras_installations\\spike\\golden-build",
    ];

    const reasons = new Map<string, string>();
    const verdicts = (() => {
      if (!ps) return new Map<string, string>();
      writeFileSync(caseFile, [...denied, ...allowed].join("\n") + "\n");
      try {
        const r = run(spikeScript("lib/Test-SpikeName.ps1"), ["-CaseFile", toHostPath(caseFile)]);
        const map = new Map<string, string>();
        for (const line of r.out.split(/\r?\n/).filter(Boolean)) {
          const [verdict, kind, name, reason] = line.split("|");
          map.set(`${kind}|${name}`, verdict ?? "");
          reasons.set(`${kind}|${name}`, reason ?? "");
        }
        return map;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();

    it.each(denied)("refuses %s", (c) => {
      expect(verdicts.get(c)).toBe("DENIED");
    });

    it.each(onDenyList)("says DENY-LIST for %s", (c) => {
      expect(reasons.get(c)).toMatch(/^DENY-LIST/);
    });

    it.each(outsideAllowlist)("does not call %s a deny-list name", (c) => {
      expect(reasons.get(c)).toMatch(/^(ALLOWLIST|PATH)/);
    });

    it.each(allowed)("allows %s", (c) => {
      expect(verdicts.get(c)).toBe("ALLOWED");
    });

    it("exits 2 for a single denied name", () => {
      const r = run(spikeScript("lib/Test-SpikeName.ps1"), ["-Kind", "Database", "-Name", "OLM_Local"]);
      expect(r.code).toBe(2);
      expect(r.out).toContain("DENIED");
    });
  });

  describe("a script given a deny-listed target fails, even in a dry run", () => {
    const cases: [string, string[]][] = [
      ["10-baseline-install.ps1", ["-Alias", "12sp9"]],
      ["10-baseline-install.ps1", ["-Alias", "InnovatorServer23"]],
      ["10-baseline-install.ps1", ["-DatabaseName", "OLM_Local"]],
      ["10-baseline-install.ps1", ["-DatabaseName", "InnovatorSolutions28"]],
      ["10-baseline-install.ps1", ["-InstallDir", "C:\\Program Files (x86)\\Aras12\\Innovator"]],
      ["10-baseline-install.ps1", ["-InstallDir", "C:\\Aras28\\Innovator"]],
      ["20-clone-slot.ps1", ["-NewAlias", "12sp9"]],
      ["20-clone-slot.ps1", ["-NewDatabase", "RabbitDemo1"]],
      ["20-clone-slot.ps1", ["-NewTree", "C:\\Program Files (x86)\\Aras\\Innovator"]],
      ["30-licence-reuse.ps1", ["-AliasA", "InnovatorServer"]],
      ["30-licence-reuse.ps1", ["-AliasB", "12sp9"]],
      ["60-sql-restore-owner.ps1", ["-ScratchDatabase", "OLM_Local"]],
      ["60-sql-restore-owner.ps1", ["-PoolLogin", "sa"]],
    ];

    it.each(cases)("%s %j", (script, args) => {
      const r = run(spikeScript(script), args);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/DENY-LIST|ALLOWLIST/);
      expect(r.out).not.toMatch(/would do:/);
    });

    it("refuses a secret passed as a property", () => {
      // A hashtable cannot be bound from -File, so call the script from a command.
      const command = `& '${toHostPath(spikeScript("10-baseline-install.ps1"))}' -MsiProperty @{ SQL_PWD = 'x' }; exit $LASTEXITCODE`;
      const r = runPs(["-Command", command]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/secret properties/);
    });

    it("reads a licence only from an install's InnovatorServerConfig.xml, each of several '|'-separated sources checked", () => {
      const good = "C:\\Program Files (x86)\\Aras12\\Innovator\\InnovatorServerConfig.xml";
      const r = run(spikeScript("30-licence-reuse.ps1"), ["-Flavor", "23", "-LicenceSourceConfig", `${good}|C:\\Program Files (x86)\\Aras28\\Innovator\\InnovatorServerConfig.xml`]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("phase 2 (Aras12)");
      expect(r.out).toContain("phase 2 (Aras28)");
      const bad = run(spikeScript("30-licence-reuse.ps1"), ["-Flavor", "23", "-LicenceSourceConfig", `${good}|C:\\aras_installations\\spike\\x.xml`]);
      expect(bad.code).toBe(2);
      expect(bad.err).toMatch(/LicenceSourceConfig must be/);
      expect(bad.out).not.toMatch(/would do:/);
    });
  });
});
