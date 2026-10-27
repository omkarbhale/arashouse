import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_STEPS, baselinePlan, type BaselinePlan, type DenyListSnapshot, type IisApplication } from "../core/baseline.js";
import { makeManifest, type Manifest } from "../core/manifest.js";
import { Secret } from "../core/secret.js";
import type { HttpAnswer } from "../host/http.js";
import { buildEditVars, newLoginPassword, parseLicenceInput, runBaselineBuild, runBuildCleanup, type BuildLogins, type BuildSystem } from "./baseline-build.js";

const MSI_SHA = "a".repeat(64);
// Assembled at run time so no secret-shaped literal sits in the source.
const LICENCE = ["LK", "-", "7Q2W", "-", "19ZX"].join("");
const ADMIN = ["ad", "!", "m1n", "-", "Pw"].join("");

const SERVER_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<Innovator>
  <DB-Connection id="arashouse_build_12sp9" database="arashouse_build_12sp9" server="(local)" dbo_uid="arashouse_build_12sp9_dbo" dbo_pwd="innovator" regular_uid="arashouse_build_12sp9_reg" regular_pwd="innovator" />
  <License lic_type="Trial" lic_key="" act_key="" company="" />
</Innovator>
`;

const APPS: IisApplication[] = ["", "/Client", "/Server"].map((subPath) => ({
  subPath,
  physicalPath: subPath === "" ? "Innovator" : `Innovator${subPath.replace("/", "\\")}`,
  role: subPath === "" ? "root" : subPath.slice(1).toLowerCase(),
  pool: { managedRuntimeVersion: "v4.0", pipelineMode: "Integrated", enable32Bit: false, identityType: "ApplicationPoolIdentity", idleTimeout: "00:20:00", startMode: "OnDemand" },
}));

type Method = Exclude<keyof BuildSystem, "now">;

/** An in-memory host: files by Windows path (case-insensitive), the throw-away instance's objects, and a call log. */
class FakeBuildSystem implements BuildSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: Method[] = [];
  readonly instance = new Set<string>();
  readonly fail = new Map<Method, Error>();
  deny: DenyListSnapshot = { "install root C:\\Program Files (x86)\\Aras12\\Innovator": "h1", "IIS pool Aras Innovator AppPool ASP.NET 4.0": "h2" };
  denyAfter: DenyListSnapshot | null = null;
  installExit = 0;
  dbList = `<DBList><DB id="arashouse_build_12sp9"/></DBList>`;
  version = "12.0.0.24090";
  loginAnswer = { ok: true, detail: "token issued" };
  missing: string[] | null = [];
  leftovers: string[] = [];
  /** What the login and restore steps were given (to check the secrets reached them). */
  readonly seen: { logins?: BuildLogins; password?: Secret } = {};
  private clock = 0;

  constructor(readonly plan: BaselinePlan) {
    for (const f of [plan.media.msi, plan.media.core, plan.media.coreAndSolutions]) this.put(f, "media");
  }

  private key(path: string): string {
    return path.toLowerCase();
  }
  put(path: string, data: string | Uint8Array): void {
    this.files.set(this.key(path), typeof data === "string" ? Buffer.from(data) : data);
  }
  text(path: string): string | undefined {
    const data = this.files.get(this.key(path));
    return data === undefined ? undefined : Buffer.from(data).toString("utf8");
  }
  under(dir: string): string[] {
    const prefix = this.key(dir) + "\\";
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }
  private act<T>(method: Method, fn: () => T): Promise<T> {
    this.calls.push(method);
    const err = this.fail.get(method);
    if (err) return Promise.reject(err);
    return Promise.resolve().then(fn);
  }

  now(): number {
    return (this.clock += 1000);
  }
  missingPrerequisites() {
    return this.act("missingPrerequisites", () => this.missing);
  }
  freeDiskGb() {
    return this.act("freeDiskGb", () => 120);
  }
  exists(path: string) {
    return this.act("exists", () => this.files.has(this.key(path)) || this.under(path).length > 0);
  }
  sha256(path: string) {
    return this.act("sha256", () => (this.key(path) === this.key(this.plan.media.msi) ? MSI_SHA : "b".repeat(64)));
  }
  survey() {
    return this.act("survey", () => this.leftovers);
  }
  snapshotDenyList() {
    return this.act("snapshotDenyList", () => {
      const first = this.calls.filter((c) => c === "snapshotDenyList").length === 1;
      return first || this.denyAfter === null ? this.deny : this.denyAfter;
    });
  }
  copyMsi() {
    return this.act("copyMsi", () => {
      this.instance.add("msi copy");
      return win32.join(this.plan.scratch.msiDir, "InnovatorSetup.msi");
    });
  }
  costMsi() {
    return this.act("costMsi", () => [] as string[]);
  }
  installMsi() {
    return this.act("installMsi", () => {
      this.instance.add("product");
      this.put(win32.join(this.plan.names.dir, "InnovatorServerConfig.xml"), SERVER_CONFIG);
      this.put(win32.join(this.plan.names.dir, "Innovator", "Server", "bin", "Aras.Server.Core.dll"), "MZ");
      return { exitCode: this.installExit, failedActions: [] as string[] };
    });
  }
  ownPools() {
    return this.act("ownPools", () => {
      this.instance.add("pools");
      return APPS;
    });
  }
  restoreDatabase(_plan: BaselinePlan, logins: BuildLogins) {
    return this.act("restoreDatabase", () => {
      this.seen.logins = logins;
      this.instance.add("database");
    });
  }
  readFile(path: string) {
    return this.act("readFile", () => {
      const data = this.files.get(this.key(path));
      if (!data) throw new Error(`ENOENT ${path}`);
      return data;
    });
  }
  writeFile(path: string, data: Uint8Array | string) {
    return this.act("writeFile", () => this.put(path, data));
  }
  /** Answers to give before the real one, by URL suffix (a cold start). */
  readonly early: HttpAnswer[] = [];
  slept = 0;
  get(url: string): Promise<HttpAnswer> {
    return this.act("get", () => this.early.shift() ?? (url.endsWith("DBList.aspx") ? { status: 200, ms: 5, body: this.dbList } : { status: 200, ms: 5 }));
  }
  sleep(ms: number): Promise<void> {
    this.slept += ms;
    return Promise.resolve();
  }
  login(_plan: BaselinePlan, _user: string, password: Secret) {
    return this.act("login", () => {
      this.seen.password = password;
      return this.loginAnswer;
    });
  }
  serverVersion() {
    return this.act("serverVersion", () => this.version);
  }
  stopPools() {
    return this.act("stopPools", () => undefined);
  }
  copyTree() {
    return this.act("copyTree", () => {
      for (const key of this.under(this.plan.names.dir)) {
        const rel = key.slice(this.plan.names.dir.length + 1);
        this.files.set(this.key(win32.join(this.plan.candidate.tree, rel)), this.files.get(key) as Uint8Array);
      }
      return { files: 2, bytes: 1234 };
    });
  }
  copyFile(from: string, to: string) {
    return this.act("copyFile", () => {
      const data = this.files.get(this.key(from));
      if (!data) throw new Error(`ENOENT ${from}`);
      this.put(to, data);
    });
  }
  backupDatabase() {
    return this.act("backupDatabase", () => this.put(this.plan.backupScratch, "ootb"));
  }
  fileSize(path: string) {
    return this.act("fileSize", () => this.files.get(this.key(path))?.length ?? 0);
  }
  removeFile(path: string) {
    return this.act("removeFile", () => void this.files.delete(this.key(path)));
  }
  removeDir(path: string) {
    return this.act("removeDir", () => {
      for (const k of this.under(path)) this.files.delete(k);
    });
  }
  rename(from: string, to: string) {
    return this.act("rename", () => {
      for (const k of this.under(from)) {
        this.files.set(this.key(to) + k.slice(from.length), this.files.get(k) as Uint8Array);
        this.files.delete(k);
      }
    });
  }
  buildManifest(plan: BaselinePlan, _tree: string, serverBuild: string): Promise<Manifest> {
    return this.act("buildManifest", () => makeManifest(plan.flavor, serverBuild, [{ path: "InnovatorServerConfig.xml", size: 10, mtime: "2026-10-27T00:00:00.0000000Z", sha256: "c".repeat(64) }]));
  }
  writeManifest(file: string, manifest: Manifest) {
    return this.act("writeManifest", () => this.put(file, JSON.stringify({ manifestHash: manifest.manifestHash })));
  }
  removeThrowaway() {
    return this.act("removeThrowaway", () => {
      this.instance.clear();
      return [] as string[];
    });
  }
  seal() {
    return this.act("seal", () => undefined);
  }
}

function setup(replace = false) {
  const plan = baselinePlan("12sp9", { msiSha256: MSI_SHA, replace });
  return { plan, system: new FakeBuildSystem(plan) };
}

const OPTIONS = { minFreeDiskGb: 10 };
const ACT = ["AK", "-", "55", "-", "QQ9"].join("");
const inputs = () => ({
  licence: { key: Secret.of(LICENCE, "licence"), actKey: Secret.of(ACT, "licence"), type: "Unlimited", company: "Example Co" },
  adminPassword: Secret.of(ADMIN, "aras-login"),
});

describe("the baseline build", () => {
  it("runs every step in order and promotes the new golden last", async () => {
    const { plan, system } = setup();
    const report = await runBaselineBuild(system, plan, OPTIONS);
    expect(report.ok).toBe(true);
    expect(report.error).toBeNull();
    expect(report.steps.map((s) => s.step)).toEqual([...BUILD_STEPS]);
    expect(report.steps.every((s) => s.status === "ok")).toBe(true);
    const order = system.calls.filter((c) => !["exists", "readFile", "writeFile", "sha256", "fileSize", "copyFile", "removeFile", "removeDir", "get", "rename"].includes(c));
    expect(order).toEqual([
      "missingPrerequisites",
      "freeDiskGb",
      "survey",
      "snapshotDenyList",
      "copyMsi",
      "costMsi",
      "installMsi",
      "ownPools",
      "restoreDatabase",
      "serverVersion",
      "stopPools",
      "copyTree",
      "backupDatabase",
      "buildManifest",
      "writeManifest",
      "removeThrowaway",
      "snapshotDenyList",
      "seal",
    ]);
    // The golden holds the tree, the backups and the records, and nothing is left under golden-build.
    const golden = plan.golden;
    for (const file of [golden.manifest, golden.edits, golden.iis, golden.service, golden.flavor, golden.ootbBackup, win32.join(golden.db, "Core120.bak"), win32.join(golden.db, "CoreAndSolutions120.bak")]) {
      expect(system.text(file), file).toBeDefined();
    }
    expect(system.under(plan.scratch.candidateDir)).toEqual([]);
    expect(system.under(plan.names.dir)).toEqual([]);
    expect(system.instance.size).toBe(0);
    expect(report.goldenHash).toMatch(/^[0-9a-f]{64}$/);
    const flavor = JSON.parse(system.text(golden.flavor) as string);
    expect(flavor).toMatchObject({ flavor: "12sp9", serverBuild: "12.0.0.24090", msiSha256: MSI_SHA, manifestHash: report.goldenHash });
    expect(flavor.backups.map((b: { file: string }) => b.file)).toEqual(["Core120.bak", "CoreAndSolutions120.bak", "ootb.bak"]);
    expect(JSON.parse(system.text(golden.iis) as string).applications).toHaveLength(3);
    expect(JSON.parse(system.text(golden.service) as string)).toMatchObject({ installed: false });
    expect(JSON.parse(system.text(golden.edits) as string).flavor).toBe("12sp9");
  });

  it("skips the login without a licence key and the admin password, and logs in with both", async () => {
    const without = setup();
    const r1 = await runBaselineBuild(without.system, without.plan, OPTIONS);
    expect(r1.loginChecked).toBe(false);
    expect(without.system.calls).not.toContain("login");
    expect(r1.steps.find((s) => s.step === "verify")?.detail).toContain("login skipped");

    const withKey = setup();
    const r2 = await runBaselineBuild(withKey.system, withKey.plan, { ...OPTIONS, inputs: inputs() });
    expect(r2.ok).toBe(true);
    expect(r2.loginChecked).toBe(true);
    expect(withKey.system.seen.password?.reveal()).toBe(ADMIN);
  });

  it("sets the secrets for the checks and blanks them before the copy, so golden holds none", async () => {
    const { plan, system } = setup();
    const report = await runBaselineBuild(system, plan, { ...OPTIONS, inputs: inputs() });
    expect(report.ok).toBe(true);
    const golden = system.text(win32.join(plan.golden.tree, "InnovatorServerConfig.xml")) as string;
    // The MSI's own lic_type and company are put back; the key and act_key are blank.
    expect(golden).toContain('<License lic_type="Trial" lic_key="" act_key="" company="" />');
    expect(golden).not.toContain(ACT);
    expect(golden).not.toContain("Example Co");
    expect(golden).toContain('lic_key=""');
    expect(golden).toContain('dbo_pwd=""');
    expect(golden).toContain('regular_pwd=""');
    expect(golden).not.toContain(LICENCE);
    const logins = system.seen.logins as BuildLogins;
    for (const secret of [logins.dbo, logins.reg]) {
      expect(secret.length).toBe(24);
      expect(golden).not.toContain(secret.reveal());
    }
    const everything = JSON.stringify(report) + [...system.files.values()].map((d) => Buffer.from(d).toString("utf8")).join("");
    for (const value of [LICENCE, ACT, ADMIN, logins.dbo.reveal(), logins.reg.reveal()]) expect(everything).not.toContain(value);
  });

  it("writes the whole <License> element for the login check", async () => {
    const { plan, system } = setup();
    let seen = "";
    const login = system.login.bind(system);
    system.login = async (p, user, password) => {
      seen = system.text(win32.join(plan.names.dir, "InnovatorServerConfig.xml")) as string;
      return login(p, user, password);
    };
    expect((await runBaselineBuild(system, plan, { ...OPTIONS, inputs: inputs() })).loginChecked).toBe(true);
    expect(seen).toContain(`<License lic_type="Unlimited" lic_key="${LICENCE}" act_key="${ACT}" company="Example Co" />`);
  });

  it("fails the copy, and keeps the secret out of golden, when a secret of the build reaches a copied config", async () => {
    const { plan, system } = setup();
    const copy = system.copyTree.bind(system);
    system.copyTree = async () => {
      const r = await copy();
      system.put(win32.join(plan.candidate.tree, "OAuthServer", "OAuthServer.config"), `<add key="x" value="${LICENCE}"/>`);
      return r;
    };
    const report = await runBaselineBuild(system, plan, { ...OPTIONS, inputs: inputs() });
    expect(report.error).toBe("capture-tree: a secret of this build is in the copied OAuthServer/OAuthServer.config");
    expect(system.under(plan.scratch.candidateDir)).toEqual([]);
    expect(system.under(plan.golden.dir)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(LICENCE);
  });

  it("refuses an existing golden without --replace, before it changes anything", async () => {
    const { plan, system } = setup();
    system.put(plan.golden.manifest, "{}");
    const report = await runBaselineBuild(system, plan, OPTIONS);
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/^preflight: the 12sp9 golden already exists/);
    expect(report.steps.filter((s) => s.status !== "skipped").map((s) => s.step)).toEqual(["preflight"]);
    expect(system.calls).not.toContain("copyMsi");
    expect(system.calls).not.toContain("removeThrowaway");
    expect(system.text(plan.golden.manifest)).toBe("{}");
  });

  it("replaces an existing golden with --replace, moving the old one aside until the new one is in place", async () => {
    const { plan, system } = setup(true);
    system.put(plan.golden.manifest, "old");
    const report = await runBaselineBuild(system, plan, OPTIONS);
    expect(report.ok).toBe(true);
    expect(system.text(plan.golden.manifest)).not.toBe("old");
    expect(system.under(plan.scratch.retiredDir)).toEqual([]);
  });

  it("holds the promoting marker for the whole move of the golden, and removes it when the move fails", async () => {
    const { plan, system } = setup(true);
    system.put(plan.golden.manifest, "old");
    const rename = system.rename.bind(system);
    const marked: boolean[] = [];
    let renames = 0;
    system.rename = (from, to) => {
      marked.push(system.text(plan.scratch.promotingMarker) !== undefined);
      return ++renames === 2 ? Promise.reject(new Error("access denied")) : rename(from, to);
    };
    const report = await runBaselineBuild(system, plan, OPTIONS);
    expect(report.error).toMatch(/^promote: access denied/);
    expect(marked.slice(0, 2)).toEqual([true, true]);
    expect(system.text(plan.scratch.promotingMarker)).toBeUndefined();
  });

  it.each([
    ["install", (s: FakeBuildSystem): void => { s.installExit = 1603; }, /install: the MSI returned 1603/],
    ["verify", (s: FakeBuildSystem): void => { s.dbList = "<DBList/>"; }, /verify: DBList.aspx lists 0 databases/],
    ["verify", (s: FakeBuildSystem): void => { s.version = "12.0.0.1"; }, /the server is 12.0.0.1, the registry says 12.0.0.24090/],
    ["capture-db", (s: FakeBuildSystem): void => { s.fail.set("backupDatabase", new Error("BACKUP failed")); }, /capture-db: BACKUP failed/],
    ["manifest", (s: FakeBuildSystem): void => { s.fail.set("buildManifest", new Error("could not hash")); }, /manifest: could not hash/],
  ] as const)("a failing %s step removes the throw-away instance and the new golden, and runs nothing after it", async (step, breakIt, error) => {
    const { plan, system } = setup();
    breakIt(system);
    const report = await runBaselineBuild(system, plan, OPTIONS);
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(error);
    const at = report.steps.findIndex((s) => s.status === "failed");
    expect(report.steps[at]?.step).toBe(step);
    expect(report.steps.slice(at + 1).every((s) => s.status === "skipped")).toBe(true);
    expect(system.calls).toContain("removeThrowaway");
    expect(system.calls.filter((c) => c === "snapshotDenyList")).toHaveLength(2);
    expect(system.calls).not.toContain("seal");
    expect(system.instance.size).toBe(0);
    expect(system.under(plan.scratch.candidateDir)).toEqual([]);
    expect(system.under(plan.golden.dir)).toEqual([]);
    expect(report.goldenHash).toBeNull();
    expect(report.leftovers).toEqual([]);
  });

  it("asks a cold application again, and names IIS's error number when it keeps failing", async () => {
    const warm = setup();
    warm.system.early.push({ status: 503, ms: 1 }, { status: 500, ms: 1 });
    expect((await runBaselineBuild(warm.system, warm.plan, OPTIONS)).ok).toBe(true);
    expect(warm.system.slept).toBe(20_000);
    const cold = setup();
    for (let i = 0; i < 6; i++) cold.system.early.push({ status: 500, ms: 1, body: "<h3>HTTP Error 500.19 - Internal Server Error</h3>" });
    const report = await runBaselineBuild(cold.system, cold.plan, OPTIONS);
    expect(report.error).toBe("verify: DBList.aspx: HTTP 500 (IIS 500.19)");
  });

  it("puts a replaced golden back when the build fails after moving it aside", async () => {
    const { plan, system } = setup(true);
    system.put(plan.golden.manifest, "old");
    const rename = system.rename.bind(system);
    let renames = 0;
    system.rename = (from, to) => (++renames === 2 ? Promise.reject(new Error("access denied")) : rename(from, to));
    const report = await runBaselineBuild(system, plan, OPTIONS);
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/^promote: access denied/);
    expect(system.text(plan.golden.manifest)).toBe("old");
  });

  it("fails when a deny-list object changed during the build, naming it only", async () => {
    const { plan, system } = setup();
    system.denyAfter = { ...system.deny, "IIS pool Aras Innovator AppPool ASP.NET 4.0": "changed" };
    const report = await runBaselineBuild(system, plan, OPTIONS);
    expect(report.ok).toBe(false);
    expect(report.error).toBe("deny-list: deny-list objects differ from before the build: changed IIS pool Aras Innovator AppPool ASP.NET 4.0");
  });

  it("refuses missing prerequisites, a changed MSI and a leftover instance in the preflight", async () => {
    const a = setup();
    a.system.missing = ["aspnetcore-2.1", "vcredist-14-x64"];
    expect((await runBaselineBuild(a.system, a.plan, OPTIONS)).error).toBe("preflight: prerequisites missing for 12sp9: aspnetcore-2.1 (install them; the tool never does)");
    const b = setup();
    b.system.missing = null;
    expect((await runBaselineBuild(b.system, b.plan, OPTIONS)).error).toMatch(/no setup record/);
    const c = setup();
    c.system.sha256 = async () => "d".repeat(64);
    expect((await runBaselineBuild(c.system, c.plan, OPTIONS)).error).toMatch(/SHA-256 differs/);
    const d = setup();
    d.system.leftovers = ["IIS application /ah-build-12sp9"];
    const report = await runBaselineBuild(d.system, d.plan, OPTIONS);
    expect(report.error).toMatch(/an earlier build left IIS application \/ah-build-12sp9; remove it with -Cleanup/);
    expect(d.system.calls).not.toContain("removeThrowaway");
    const e = setup();
    expect((await runBaselineBuild(e.system, e.plan, { minFreeDiskGb: 500 })).error).toMatch(/120 GB free at the root, under min_free_disk_gb 500/);
  });

  it("reports what a failed cleanup left, by name", async () => {
    const { plan, system } = setup();
    system.installExit = 1603;
    system.removeThrowaway = async () => ["database arashouse_build_12sp9"];
    const report = await runBaselineBuild(system, plan, OPTIONS);
    expect(report.leftovers).toEqual(["database arashouse_build_12sp9"]);
  });

  it("cleans up a failed build's leftovers on request, and nothing else", async () => {
    const { plan, system } = setup();
    system.put(win32.join(plan.names.dir, "x.txt"), "x");
    system.put(plan.golden.manifest, "keep");
    expect(await runBuildCleanup(system, plan)).toEqual([]);
    expect(system.under(plan.names.dir)).toEqual([]);
    expect(system.text(plan.golden.manifest)).toBe("keep");
  });
});

describe("build helpers", () => {
  it("reads the licence input as a bare key or as a JSON <License> element", () => {
    expect(parseLicenceInput(Secret.of(LICENCE, "licence")).key.reveal()).toBe(LICENCE);
    const full = parseLicenceInput(Secret.of(JSON.stringify({ lic_type: "Unlimited", lic_key: LICENCE, act_key: ACT, company: "Example Co" }), "licence"));
    expect(full.key.reveal()).toBe(LICENCE);
    expect(full.actKey?.reveal()).toBe(ACT);
    expect(full.actKey?.kind).toBe("licence");
    expect([full.type, full.company]).toEqual(["Unlimited", "Example Co"]);
    expect(() => parseLicenceInput(Secret.of('{"act_key":"x"}', "licence"))).toThrow(/no lic_key/);
    expect(() => parseLicenceInput(Secret.of("{nope", "licence"))).toThrow(/neither a key nor/);
  });

  it("generates 24-character login passwords, each different", () => {
    const a = newLoginPassword();
    const b = newLoginPassword();
    expect(a.kind).toBe("sql-login");
    expect(a.reveal()).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(a.reveal()).not.toBe(b.reveal());
  });

  it("gives the build instance's own names as its template variables", () => {
    const plan = baselinePlan("23", { msiSha256: MSI_SHA });
    expect(buildEditVars(plan)).toMatchObject({
      alias: "ah-build-23",
      database: "arashouse_build_23",
      "login.dbo": "arashouse_build_23_dbo",
      slotDir: "C:\\aras_installations\\golden-build\\23",
      "build.dir": "C:\\aras_installations\\golden-build\\23",
    });
  });
});
