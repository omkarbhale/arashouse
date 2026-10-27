// `arashouse baseline build <flavor>` and `arashouse baseline verify <flavor>` (tickets 24 and 28,
// docs/baselines.md). `build` runs on WSL as the worker: it checks the media (ticket 18) and that no
// golden would be overwritten without `--replace`, marks the flavor's slots dirty when it replaces,
// and writes the bundle the captain runs elevated (`staging\baseline-<key>\baseline-build.ps1`).
// `verify` asks the broker to check the golden against its manifest.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ENGINE_BUNDLE_DIR, MSI_BUILT_IN_PROPERTIES, MSI_CUSTOM_ACTION_PROPERTIES, baselinePlan, msiInstallProperties } from "../core/baseline.js";
import { BUILD_SCRIPT_NAME, PLAN_FILE, RESULT_FILE, renderBaselineBuildScript, type BundlePlan, type PinnedFile } from "../core/baseline-script.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import { FLAVOR_KEYS, getFlavor, isFlavorKey, type FlavorKey } from "../core/flavors.js";
import { UsageError } from "../core/lease.js";
import { missingProperties, type FlavorMediaReport } from "../core/media-check.js";
import { buildScratch } from "../core/names.js";
import type { StateStore } from "../core/store.js";
import { extractZipEntry, findZipEntry, listZip } from "../core/zip.js";
import { STEPS_SCRIPT_NAME, renderBuildStepsScript } from "../broker/baseline-steps.js";
import type { HostDriver } from "../host/driver.js";
import { HostError, isHostError } from "../host/errors.js";
import { parseArgs, type ParsedArgs } from "./args.js";
import { collectAppFiles, wslPathOf } from "./setup.js";

/** The names a baseline bundle holds; anything else in the folder means it is not ours, and it is left alone. */
const BUNDLE_ENTRIES = new Set([BUILD_SCRIPT_NAME, STEPS_SCRIPT_NAME, PLAN_FILE, RESULT_FILE, "package.json", "app", "media", ENGINE_BUNDLE_DIR]);

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The media check's verdict as one line, or null when the build may use the media. */
export function mediaRefusal(report: FlavorMediaReport, flavor: FlavorKey): string | null {
  if (!report.ok) return `the ${flavor} media do not pass \`arashouse media check ${flavor}\`: ${report.problems.join("; ") || "see its report"}`;
  if (!report.msi?.read) return `the ${flavor} MSI could not be read (${report.msi?.error ?? "no MSI"})`;
  const unlisted = [...MSI_BUILT_IN_PROPERTIES, ...MSI_CUSTOM_ACTION_PROPERTIES];
  const needed = Object.keys(msiInstallProperties(baselinePlan(flavor, { msiSha256: "0".repeat(64) }))).filter((p) => !unlisted.includes(p));
  const lacking = missingProperties(report.msi.publicProperties, needed);
  if (lacking.length > 0) return `the ${flavor} MSI has no ${lacking.join(", ")}, which the unattended install sets`;
  return null;
}

export interface BaselineBundleOptions {
  readonly flavor: FlavorKey;
  /** The media check's report (ticket 18): where each file is, loose or in a zip. */
  readonly media: FlavorMediaReport;
  /** The built `dist\` the bundle runs. */
  readonly distDir: string;
  readonly packageJson: string;
  readonly version: string;
  readonly minFreeDiskGb: number;
  /** The bundle folder as a local path; defaults to the WSL path of `staging\baseline-<key>`. */
  readonly outDir?: string;
  /** A built import-export-libs-js checkout to bundle for the engine check (`--engine-check <dir>`). */
  readonly engineDir?: string;
}

export interface BaselineBundle {
  /** The script's Windows path. */
  readonly script: string;
  readonly files: number;
  readonly msiSha256: string;
}

/** Copies (or unpacks, with the CRC-32 check) one media file into the bundle. */
async function stageMedia(report: FlavorMediaReport, name: string, dest: string): Promise<void> {
  const file = report.files.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!file || file.state !== "present") throw new UsageError(`the ${report.flavor} media have no ${name}`);
  if (file.location === "zip" && file.zip !== undefined) {
    const entry = findZipEntry(await listZip(file.zip), name);
    if (!entry) throw new UsageError(`${file.zip} has no ${name}`);
    await extractZipEntry(file.zip, entry, dest);
  } else {
    await copyFile(file.path, dest);
  }
}

/**
 * The files of a built import-export-libs-js checkout the engine check runs, relative to it and `/`-separated:
 * `package.json`, the `.js` files of `dist/` (no source maps or typings), and every file of each runtime dependency
 * under `node_modules/`. Refuses a checkout that is not built, or a dependency with dependencies of its own (they
 * are not bundled).
 */
export async function engineFiles(dir: string): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8").catch(() => "{}")) as { name?: unknown; dependencies?: Record<string, string> };
  if (pkg.name !== "import-export-libs-js") throw new UsageError(`${dir} is not an import-export-libs-js checkout (its package.json names ${JSON.stringify(pkg.name ?? null)})`);
  if (!existsSync(join(dir, "dist", "cli.js"))) throw new UsageError(`${dir} has no dist/cli.js: build it first (npm ci, npm run build)`);
  const walk = async (rel: string, keep: (name: string) => boolean): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) out.push(...(await walk(path, keep)));
      else if (entry.isFile() && keep(entry.name)) out.push(path);
      else if (!entry.isFile()) throw new UsageError(`${join(dir, path)} is not a plain file or folder`);
    }
    return out;
  };
  const files = ["package.json", ...(await walk("dist", (n) => n.endsWith(".js")))];
  for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) {
    const depPkg = JSON.parse(await readFile(join(dir, "node_modules", dep, "package.json"), "utf8").catch(() => "null")) as { dependencies?: Record<string, string> } | null;
    if (depPkg === null) throw new UsageError(`${dir} has no node_modules/${dep}: install its dependencies first (npm ci)`);
    if (Object.keys(depPkg.dependencies ?? {}).length > 0) throw new UsageError(`node_modules/${dep} has dependencies of its own, which the engine bundle does not carry`);
    files.push(...(await walk(`node_modules/${dep}`, () => true)));
  }
  return files;
}

/**
 * Writes the bundle: `baseline-build.ps1` (every other file pinned by SHA-256 in it), `baseline-steps.ps1`,
 * `plan.json`, `package.json`, `app\` (a copy of `distDir`), `media\` (the MSI and the two backups) and, with
 * `engineDir`, `engine\` (the libs-js CLI the engine check runs).
 * Replaces an earlier bundle there; refuses a folder that holds anything else.
 */
export async function writeBaselineBundle(options: BaselineBundleOptions): Promise<BaselineBundle> {
  if (!existsSync(join(options.distDir, "broker", "baseline-main.js"))) {
    throw new UsageError("arashouse baseline build bundles the build: run it from the build (`npm run build`, then `node dist/cli/index.js baseline build <flavor>`)");
  }
  const refusal = mediaRefusal(options.media, options.flavor);
  if (refusal) throw new UsageError(refusal);
  const scratch = buildScratch(options.flavor);
  const outDir = options.outDir ?? wslPathOf(scratch.bundleDir);
  if (existsSync(outDir)) {
    const foreign = (await readdir(outDir)).filter((name) => !BUNDLE_ENTRIES.has(name));
    if (foreign.length > 0) throw new UsageError(`${outDir} holds ${foreign.slice(0, 3).join(", ")}, which a baseline bundle does not; move it away first`);
  }
  for (const entry of ["app", "media", ENGINE_BUNDLE_DIR, RESULT_FILE]) await rm(join(outDir, entry), { recursive: true, force: true });
  await mkdir(join(outDir, "media"), { recursive: true });

  const f = getFlavor(options.flavor);
  const pinned: PinnedFile[] = [];
  for (const name of [f.msiName, f.backups.core, f.backups.coreAndSolutions]) {
    await stageMedia(options.media, name, join(outDir, "media", name));
    pinned.push({ path: `media\\${name}`, sha256: await sha256File(join(outDir, "media", name)) });
  }
  const msiSha256 = (pinned[0] as PinnedFile).sha256;

  const appFiles = await collectAppFiles(options.distDir);
  for (const file of appFiles) {
    const target = join(outDir, "app", ...file.path.split("\\"));
    await mkdir(join(target, ".."), { recursive: true });
    await copyFile(join(options.distDir, ...file.path.split("\\")), target);
    pinned.push({ path: `app\\${file.path}`, sha256: file.sha256 });
  }
  if (options.engineDir !== undefined) {
    for (const rel of await engineFiles(options.engineDir)) {
      const target = join(outDir, ENGINE_BUNDLE_DIR, ...rel.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(join(options.engineDir, ...rel.split("/")), target);
      pinned.push({ path: `${ENGINE_BUNDLE_DIR}\\${rel.split("/").join("\\")}`, sha256: await sha256File(target) });
    }
  }
  const write = async (name: string, data: string | Buffer, encoding?: "ascii") => {
    await writeFile(join(outDir, name), data, encoding);
    pinned.push({ path: name, sha256: createHash("sha256").update(await readFile(join(outDir, name))).digest("hex") });
  };
  await write("package.json", await readFile(options.packageJson));
  const plan: BundlePlan = {
    schema: 1,
    flavor: options.flavor,
    msiSha256,
    minFreeDiskGb: options.minFreeDiskGb,
    version: options.version,
    ...(options.engineDir !== undefined ? { engineCheck: true } : {}),
  };
  await write(PLAN_FILE, `${JSON.stringify(plan, null, 2)}\n`);
  const steps = renderBuildStepsScript();
  if (!/^[\x00-\x7f]*$/.test(steps)) throw new Error("the generated steps script is not plain ASCII, which Windows PowerShell 5.1 would misread");
  await write(STEPS_SCRIPT_NAME, steps.replace(/\r?\n/g, "\r\n"), "ascii");

  const script = renderBaselineBuildScript({ flavor: options.flavor, version: options.version, pinned });
  if (!/^[\x00-\x7f]*$/.test(script)) throw new Error("the generated script is not plain ASCII, which Windows PowerShell 5.1 would misread");
  await writeFile(join(outDir, BUILD_SCRIPT_NAME), script.replace(/\r?\n/g, "\r\n"), "ascii");
  return { script: `${scratch.bundleDir}\\${BUILD_SCRIPT_NAME}`, files: pinned.length, msiSha256 };
}

/**
 * `--replace`: every slot of the flavor that is free (or between resets) goes to `dirty`, so it is
 * reset from the new golden before it is handed out. A leased slot goes dirty when it is returned;
 * a quarantined or disabled one through `repair` or `enable`, which reset it. Returns the slots moved.
 */
export async function markFlavorDirty(store: StateStore, flavor: FlavorKey): Promise<string[]> {
  const moved: string[] = [];
  await store.update((tx) => {
    for (const slot of Object.values(tx.snapshot())) {
      if (slot.flavor !== flavor) continue;
      if (slot.status === "free" || slot.status === "resetting" || slot.status === "provisioning") {
        tx.transition(slot.id, { to: "dirty" }, `the ${flavor} golden is being replaced`);
        moved.push(slot.id);
      }
    }
  });
  return moved;
}

export const BASELINE_USAGE = "usage: arashouse baseline build <flavor> [--replace] [--engine-check <libs-js>] | arashouse baseline verify <flavor> [--full] [--json]";

export interface BaselineCommandDeps {
  readonly host: Pick<HostDriver, "baselineVerify">;
  readonly store: StateStore;
  /** The media check of one flavor (ticket 18). */
  readonly checkMedia: (flavor: FlavorKey) => Promise<FlavorMediaReport>;
  /** Writes the bundle; `writeBaselineBundle` with the build's own `dist\` (and the libs-js checkout of `--engine-check`). */
  readonly writeBundle: (flavor: FlavorKey, media: FlavorMediaReport, engineDir?: string) => Promise<BaselineBundle>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function oneFlavor(parsed: ParsedArgs, command: string): FlavorKey {
  const [flavor, extra] = parsed.positionals;
  if (flavor === undefined) throw new UsageError(`baseline ${command} needs a flavor: ${FLAVOR_KEYS.join(", ")}`);
  if (extra !== undefined) throw new UsageError(`baseline ${command} takes one flavor, not "${extra}" too`);
  if (!isFlavorKey(flavor)) throw new UsageError(`unknown flavor "${flavor}"; the flavors are ${FLAVOR_KEYS.join(", ")}`);
  return flavor;
}

/** `baseline build`: refuse to overwrite a golden without `--replace`, check the media, mark slots dirty on replace, write the bundle. */
async function baselineBuild(deps: BaselineCommandDeps, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { replace: "flag", "engine-check": "value" });
  const flavor = oneFlavor(parsed, "build");
  const replace = parsed.options.replace === true;
  const engineDir = typeof parsed.options["engine-check"] === "string" ? parsed.options["engine-check"] : undefined;
  let built: boolean | null = null;
  try {
    const verify = await deps.host.baselineVerify(flavor);
    built = verify.ok || verify.diff !== undefined;
  } catch (err) {
    // A broker older than this ticket has no baselineVerify verb and refuses it by name.
    const older = isHostError(err, "Refused") && err.message.includes('has no "baselineVerify" verb');
    if (!isHostError(err, "Unreachable") && !older) throw err;
    deps.err(`arashouse: cannot ask the broker whether a ${flavor} golden exists (${err.message}); the build script checks again`);
  }
  if (built === true && !replace) {
    throw new HostError("Refused", `the ${flavor} golden already exists; rebuild it only with --replace, which resets every ${flavor} slot from the new golden`);
  }
  const media = await deps.checkMedia(flavor);
  const refusal = mediaRefusal(media, flavor);
  if (refusal) throw new UsageError(refusal);
  if (replace) {
    const moved = await markFlavorDirty(deps.store, flavor);
    deps.out(moved.length > 0 ? `marked ${moved.join(", ")} dirty: each is reset from the new golden before it is handed out` : `no free ${flavor} slot to mark dirty`);
  }
  const bundle = await deps.writeBundle(flavor, media, engineDir);
  const switches = replace ? " -Replace" : "";
  for (const line of [
    `wrote ${bundle.script} (${bundle.files} files pinned by SHA-256; MSI ${bundle.msiSha256.slice(0, 12)})`,
    "in an elevated Windows PowerShell (Run as administrator):",
    `  powershell -NoProfile -ExecutionPolicy Bypass -File "${bundle.script}"                    # check the bundle, change nothing`,
    `  powershell -NoProfile -ExecutionPolicy Bypass -File "${bundle.script}" -Apply${switches}             # build (no login check)`,
    `  powershell -NoProfile -ExecutionPolicy Bypass -File "${bundle.script}" -Apply${switches} -AskLicence -AskAdminPassword   # ... and log in as root${engineDir !== undefined ? `, then export one item with engine ${getFlavor(flavor).libsJsEngine}` : ""}`,
    `then, from WSL: arashouse baseline verify ${flavor} (docs/baselines.md)`,
  ]) {
    deps.out(line);
  }
  return EXIT_CODES.ok;
}

/** `baseline verify`: the broker checks the golden against its manifest; exit 1 when it does not verify. */
async function baselineVerify(deps: BaselineCommandDeps, args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, { full: "flag", json: "flag" });
  const flavor = oneFlavor(parsed, "verify");
  const result = await deps.host.baselineVerify(flavor, { level: parsed.options.full === true ? "full" : "golden" });
  if (parsed.options.json === true) {
    deps.out(JSON.stringify({ flavor, ok: result.ok, level: result.level, detail: result.detail, diff: result.diff ?? null }, null, 2));
  } else {
    deps.out(result.detail);
    const diff = result.diff;
    if (diff && !diff.ok) {
      for (const p of diff.missing) deps.out(`  missing  ${p}`);
      for (const c of diff.changed) deps.out(`  changed  ${c.path} (${c.reasons.join(", ")})`);
      for (const p of diff.extra) deps.out(`  extra    ${p}`);
      if (diff.truncated) deps.out("  ... (the first paths of each kind only)");
    }
  }
  return result.ok ? EXIT_CODES.ok : 1;
}

export async function runBaselineCommand(deps: BaselineCommandDeps, args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "build") return baselineBuild(deps, rest);
  if (command === "verify") return baselineVerify(deps, rest);
  throw new UsageError(command === undefined ? `baseline needs a command: ${BASELINE_USAGE}` : `unknown command "baseline ${command}"`);
}
