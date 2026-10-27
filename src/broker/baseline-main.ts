#!/usr/bin/env node
// The baseline build's entry on Windows (ticket 24): `baseline-build.ps1` runs it under Node in the
// captain's elevated session, from the bundle `arashouse baseline build` wrote:
//
//   node.exe <bundle>\app\broker\baseline-main.js [--replace] [--cleanup]
//
// It reads `<bundle>\plan.json` (the flavor and the MSI's SHA-256 the CLI checked), derives every name
// from the flavor, runs the steps (baseline-build.ts) and prints one line per step, then `result:` and
// the report as JSON, which it also writes to `<bundle>\result.json`. The licence key and the shipped
// admin password, when given, arrive in the environment the script set for this process only.

import { readFile, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { baselinePlan, goldenJson, type BuildReport, type StepRecord } from "../core/baseline.js";
import { BUILD_ENV_NAMES, PLAN_FILE, RESULT_FILE, type BundlePlan } from "../core/baseline-script.js";
import { isFlavorKey } from "../core/flavors.js";
import { buildScratch } from "../core/names.js";
import { redactError } from "../core/redact.js";
import { secretFromEnv } from "../core/secret.js";
import { parseLicenceInput, runBaselineBuild, runBuildCleanup } from "./baseline-build.js";
import { STEPS_SCRIPT_NAME } from "./baseline-steps.js";
import { windowsBuildSystem } from "./build-system.js";

function formatStep(r: StepRecord): string {
  return `${r.status.padEnd(7)} ${r.step} (${r.seconds} s): ${r.detail}`;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--replace" && a !== "--cleanup");
  if (process.platform !== "win32" || unknown.length > 0) {
    process.stderr.write("usage (on Windows, elevated, through baseline-build.ps1): baseline-main.js [--replace] [--cleanup]\n");
    return 2;
  }
  // Set by baseline-build.ps1 for this process only; read once and removed.
  const licenceText = secretFromEnv(BUILD_ENV_NAMES.licence, "licence");
  const licence = licenceText ? parseLicenceInput(licenceText) : undefined;
  const adminPassword = secretFromEnv(BUILD_ENV_NAMES.admin, "aras-login");
  const bundle = fileURLToPath(new URL("../../", import.meta.url));
  const bundlePlan = JSON.parse(await readFile(win32.join(bundle, PLAN_FILE), "utf8")) as BundlePlan;
  if (bundlePlan.schema !== 1 || !isFlavorKey(bundlePlan.flavor)) throw new Error("plan.json names no registered flavor");
  const plan = baselinePlan(bundlePlan.flavor, { msiSha256: bundlePlan.msiSha256, replace: args.includes("--replace") });
  // The bundle must be the one the plan derives: the steps script reads the media from there.
  if (win32.resolve(bundle).toLowerCase() !== win32.resolve(buildScratch(plan.flavor).bundleDir).toLowerCase()) {
    throw new Error(`the bundle must sit at ${buildScratch(plan.flavor).bundleDir}, not ${bundle}`);
  }
  const system = windowsBuildSystem(plan, { stepsScript: win32.join(bundle, STEPS_SCRIPT_NAME), onLog: (line) => process.stdout.write(`  ${line}\n`) });

  if (args.includes("--cleanup")) {
    const left = await runBuildCleanup(system, plan);
    process.stdout.write(`result: ${JSON.stringify({ ok: left.length === 0, flavor: plan.flavor, cleanup: true, leftovers: left })}\n`);
    return left.length === 0 ? 0 : 1;
  }
  const report: BuildReport = await runBaselineBuild(system, plan, {
    inputs: { licence, adminPassword },
    minFreeDiskGb: bundlePlan.minFreeDiskGb,
    onStep: (r) => process.stdout.write(`${formatStep(r)}\n`),
  });
  await writeFile(win32.join(bundle, RESULT_FILE), goldenJson(report));
  process.stdout.write(`result: ${JSON.stringify(report)}\n`);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`baseline build: ${redactError(err).message}\n`);
    process.exitCode = 1;
  },
);
