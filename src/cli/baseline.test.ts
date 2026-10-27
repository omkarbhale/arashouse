import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselinePlan, msiInstallProperties, MSI_BUILT_IN_PROPERTIES } from "../core/baseline.js";
import { BUILD_SCRIPT_NAME } from "../core/baseline-script.js";
import type { FlavorKey } from "../core/flavors.js";
import { MEDIA_ENV } from "../core/media.js";
import { checkMedia, type FlavorMediaReport } from "../core/media-check.js";
import { StateStore } from "../core/store.js";
import { FakeHost } from "../host/fake.js";
import { HostError } from "../host/errors.js";
import { STEPS_SCRIPT_NAME } from "../broker/baseline-steps.js";
import { engineFiles, markFlavorDirty, mediaRefusal, runBaselineCommand, writeBaselineBundle, type BaselineCommandDeps } from "./baseline.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arashouse-baseline-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NEEDED = Object.keys(msiInstallProperties(baselinePlan("12sp9", { msiSha256: "0".repeat(64) }))).filter((p) => !MSI_BUILT_IN_PROPERTIES.includes(p));

async function media(names: readonly string[] = [...NEEDED, "LICENSEKEY"]): Promise<FlavorMediaReport> {
  const folder = join(dir, "media", "12sp9");
  mkdirSync(folder, { recursive: true });
  for (const f of ["InnovatorSetup.msi", "Core120.bak", "CoreAndSolutions120.bak"]) writeFileSync(join(folder, f), `bytes of ${f}`);
  return checkMedia("12sp9", {
    env: { [MEDIA_ENV]: join(dir, "media") },
    startDir: dir,
    readMsi: async () => ({ productName: "Aras Innovator", manufacturer: "Aras Corporation", productVersion: "12.0.0", names }),
  });
}

function dist(): string {
  const d = join(dir, "dist");
  mkdirSync(join(d, "broker"), { recursive: true });
  writeFileSync(join(d, "broker", "baseline-main.js"), "// main\n");
  writeFileSync(join(d, "broker", "client.js"), "// client\n");
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  return d;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

describe("the baseline bundle", () => {
  it("holds the script, the steps, the plan, the build and the media, each pinned by SHA-256", async () => {
    const out = join(dir, "bundle");
    const bundle = await writeBaselineBundle({ flavor: "12sp9", media: await media(), distDir: dist(), packageJson: join(dir, "package.json"), version: "0.0.0", minFreeDiskGb: 10, outDir: out });
    expect(bundle.script).toBe("C:\\aras_installations\\staging\\baseline-12sp9\\baseline-build.ps1");
    expect(bundle.msiSha256).toBe(sha("bytes of InnovatorSetup.msi"));
    const script = readFileSync(join(out, BUILD_SCRIPT_NAME), "latin1");
    expect(script).toMatch(/^[\x00-\x7f]*$/);
    expect(script).toContain("\r\n");
    for (const rel of ["media/InnovatorSetup.msi", "media/Core120.bak", "media/CoreAndSolutions120.bak", "app/broker/baseline-main.js", "app/broker/client.js", "package.json", "plan.json", STEPS_SCRIPT_NAME]) {
      const hash = sha(readFileSync(join(out, ...rel.split("/"))));
      expect(script, rel).toContain(`@{ path = '${rel.replace(/\//g, "\\")}'; sha256 = '${hash}' }`);
    }
    expect(JSON.parse(readFileSync(join(out, "plan.json"), "utf8"))).toEqual({ schema: 1, flavor: "12sp9", msiSha256: bundle.msiSha256, minFreeDiskGb: 10, version: "0.0.0" });
    expect(bundle.files).toBe(8);
  });

  it("bundles a built libs-js checkout for the engine check, pinned, and asks for the check in plan.json", async () => {
    const libs = join(dir, "libs-js");
    mkdirSync(join(libs, "dist"), { recursive: true });
    mkdirSync(join(libs, "node_modules", "@xmldom", "xmldom", "lib"), { recursive: true });
    mkdirSync(join(libs, "node_modules", "xpath"), { recursive: true });
    writeFileSync(join(libs, "package.json"), JSON.stringify({ name: "import-export-libs-js", dependencies: { "@xmldom/xmldom": "0.9.12", xpath: "0.0.34" } }));
    for (const f of ["cli.js", "chunk-A.js", "cli.js.map", "index.d.ts"]) writeFileSync(join(libs, "dist", f), `// ${f}\n`);
    writeFileSync(join(libs, "node_modules", "@xmldom", "xmldom", "package.json"), "{}");
    writeFileSync(join(libs, "node_modules", "@xmldom", "xmldom", "lib", "dom.js"), "// dom\n");
    writeFileSync(join(libs, "node_modules", "xpath", "package.json"), "{}");
    writeFileSync(join(libs, "node_modules", "xpath", "xpath.js"), "// xpath\n");
    const out = join(dir, "bundle");
    const bundle = await writeBaselineBundle({ flavor: "12sp9", media: await media(), distDir: dist(), packageJson: join(dir, "package.json"), version: "0.0.0", minFreeDiskGb: 10, outDir: out, engineDir: libs });
    const script = readFileSync(join(out, BUILD_SCRIPT_NAME), "latin1");
    const bundled = ["engine/package.json", "engine/dist/chunk-A.js", "engine/dist/cli.js", "engine/node_modules/@xmldom/xmldom/lib/dom.js", "engine/node_modules/@xmldom/xmldom/package.json", "engine/node_modules/xpath/package.json", "engine/node_modules/xpath/xpath.js"];
    for (const rel of bundled) expect(script, rel).toContain(`@{ path = '${rel.replace(/\//g, "\\")}'; sha256 = '${sha(readFileSync(join(out, ...rel.split("/"))))}' }`);
    expect(script).not.toContain("cli.js.map");
    expect(script).not.toContain("index.d.ts");
    expect(bundle.files).toBe(8 + bundled.length);
    expect(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")).engineCheck).toBe(true);
    // A later bundle without the check drops the engine folder.
    await writeBaselineBundle({ flavor: "12sp9", media: await media(), distDir: dist(), packageJson: join(dir, "package.json"), version: "0.0.0", minFreeDiskGb: 10, outDir: out });
    expect(existsSync(join(out, "engine"))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")).engineCheck).toBeUndefined();
  });

  it("refuses an engine checkout that is not libs-js, not built, or has transitive dependencies", async () => {
    const libs = join(dir, "libs-js");
    mkdirSync(join(libs, "dist"), { recursive: true });
    writeFileSync(join(libs, "package.json"), JSON.stringify({ name: "other" }));
    await expect(engineFiles(libs)).rejects.toThrow(/is not an import-export-libs-js checkout/);
    writeFileSync(join(libs, "package.json"), JSON.stringify({ name: "import-export-libs-js", dependencies: { xpath: "1" } }));
    await expect(engineFiles(libs)).rejects.toThrow(/no dist\/cli.js/);
    writeFileSync(join(libs, "dist", "cli.js"), "//\n");
    await expect(engineFiles(libs)).rejects.toThrow(/no node_modules\/xpath/);
    mkdirSync(join(libs, "node_modules", "xpath"), { recursive: true });
    writeFileSync(join(libs, "node_modules", "xpath", "package.json"), JSON.stringify({ dependencies: { other: "1" } }));
    await expect(engineFiles(libs)).rejects.toThrow(/dependencies of its own/);
  });

  it("refuses media that fail the check or lack a property the install sets, and a folder that is not a bundle", async () => {
    const lacking = await media(NEEDED.filter((p) => p !== "INSTALL_DATABASE"));
    expect(mediaRefusal(lacking, "12sp9")).toBe("the 12sp9 MSI has no INSTALL_DATABASE, which the unattended install sets");
    // The 14.x MSIs have no INNOVATOR_TO_SERVICE_ADDRESS row, though their custom actions read it: not required.
    expect(mediaRefusal(await media(NEEDED.filter((p) => p !== "INNOVATOR_TO_SERVICE_ADDRESS")), "12sp9")).toBeNull();
    expect(mediaRefusal(await media(NEEDED.filter((p) => p !== "AS_FOLDER")), "12sp9")).toBe("the 12sp9 MSI has no AS_FOLDER, which the unattended install sets");
    rmSync(join(dir, "media", "12sp9", "Core120.bak"));
    const broken = await checkMedia("12sp9", { env: { [MEDIA_ENV]: join(dir, "media") }, startDir: dir, readMsi: async () => ({ productVersion: "12.0.0", names: NEEDED }) });
    expect(mediaRefusal(broken, "12sp9")).toMatch(/do not pass `arashouse media check 12sp9`/);
    const out = join(dir, "bundle");
    mkdirSync(out);
    writeFileSync(join(out, "notes.txt"), "mine");
    await expect(writeBaselineBundle({ flavor: "12sp9", media: await media(), distDir: dist(), packageJson: join(dir, "package.json"), version: "0.0.0", minFreeDiskGb: 10, outDir: out })).rejects.toThrow(/notes.txt/);
  });
});

describe("arashouse baseline", () => {
  async function deps(options: { baselines?: FlavorKey[]; host?: BaselineCommandDeps["host"] } = {}) {
    const store = new StateStore({ home: join(dir, "home") });
    const out: string[] = [];
    const err: string[] = [];
    const written: FlavorKey[] = [];
    const engines: (string | undefined)[] = [];
    const report = await media();
    const d: BaselineCommandDeps = {
      host: options.host ?? new FakeHost({ baselines: options.baselines ?? [] }),
      store,
      checkMedia: async () => report,
      writeBundle: async (flavor, _media, engineDir) => {
        written.push(flavor);
        engines.push(engineDir);
        return { script: `C:\\aras_installations\\staging\\baseline-${flavor}\\baseline-build.ps1`, files: 9, msiSha256: "f".repeat(64) };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    };
    return { d, store, out, err, written, engines };
  }

  it("writes the bundle for a flavor with no golden and prints the elevated commands", async () => {
    const t = await deps();
    expect(await runBaselineCommand(t.d, ["build", "12sp9"])).toBe(0);
    expect(t.written).toEqual(["12sp9"]);
    expect(t.out.join("\n")).toContain('-File "C:\\aras_installations\\staging\\baseline-12sp9\\baseline-build.ps1" -Apply');
    expect(t.out.join("\n")).not.toContain("-Replace");
    expect(t.engines).toEqual([undefined]);
  });

  it("passes --engine-check's libs-js checkout to the bundle and says the build will export one item", async () => {
    const t = await deps();
    expect(await runBaselineCommand(t.d, ["build", "23", "--engine-check", "/src/libs-js"])).toBe(0);
    expect(t.engines).toEqual(["/src/libs-js"]);
    expect(t.out.join("\n")).toContain("then export one item with engine 14.0.7");
  });

  it("refuses to replace an existing golden without --replace, and writes nothing", async () => {
    const t = await deps({ baselines: ["12sp9"] });
    const err = await runBaselineCommand(t.d, ["build", "12sp9"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).kind).toBe("Refused");
    expect((err as HostError).message).toMatch(/already exists; rebuild it only with --replace/);
    expect(t.written).toEqual([]);
  });

  it("with --replace marks the flavor's free and resetting slots dirty, leaves leased ones, and writes a -Replace bundle", async () => {
    const t = await deps({ baselines: ["12sp9"] });
    await t.store.update((tx) => {
      for (const n of [1, 2, 3]) {
        const s = tx.addSlot({ flavor: "12sp9", slot: n });
        tx.transition(s.id, { to: "free", golden_hash: "old", reset_ms: 1 });
      }
      tx.transition("12sp9-02", { to: "leased", holder: "task" });
      const other = tx.addSlot({ flavor: "23", slot: 1 });
      tx.transition(other.id, { to: "free", golden_hash: "g", reset_ms: 1 });
    });
    expect(await runBaselineCommand(t.d, ["build", "12sp9", "--replace"])).toBe(0);
    const state = await t.store.read();
    expect(state.slots["12sp9-01"]?.status).toBe("dirty");
    expect(state.slots["12sp9-02"]?.status).toBe("leased");
    expect(state.slots["12sp9-03"]?.status).toBe("dirty");
    expect(state.slots["23-01"]?.status).toBe("free");
    expect(t.out[0]).toBe("marked 12sp9-01, 12sp9-03 dirty: each is reset from the new golden before it is handed out");
    expect(t.out.join("\n")).toContain("-Apply -Replace");
    expect(await markFlavorDirty(t.store, "12sp9")).toEqual([]);
  });

  it("still writes the bundle when the broker cannot be asked, saying the script checks again", async () => {
    const t = await deps({ host: { baselineVerify: async () => Promise.reject(new HostError("Unreachable", "no pipe")) } });
    expect(await runBaselineCommand(t.d, ["build", "12sp9"])).toBe(0);
    expect(t.err[0]).toMatch(/cannot ask the broker whether a 12sp9 golden exists \(no pipe\); the build script checks again/);
  });

  it("verifies a golden: exit 0 when it verifies, 1 when it does not, --full asks for every hash", async () => {
    const t = await deps({ baselines: ["12sp9"] });
    expect(await runBaselineCommand(t.d, ["verify", "12sp9"])).toBe(0);
    expect(t.out).toEqual(["the 12sp9 baseline verifies (golden)"]);
    expect(await runBaselineCommand(t.d, ["verify", "23"])).toBe(1);
    expect(await runBaselineCommand(t.d, ["verify", "12sp9", "--full", "--json"])).toBe(0);
    expect(JSON.parse(t.out.slice(2).join("\n"))).toMatchObject({ flavor: "12sp9", ok: true, level: "full" });
  });

  it("refuses an unknown command, flavor or option as usage", async () => {
    const t = await deps();
    for (const args of [[], ["make", "12sp9"], ["build"], ["build", "olm"], ["build", "12sp9", "23"], ["verify", "12sp9", "--fast"]]) {
      await expect(runBaselineCommand(t.d, args), args.join(" ")).rejects.toThrow();
    }
  });
});
