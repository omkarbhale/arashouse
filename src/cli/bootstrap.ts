// A bootstrap recipe from the CLI (ticket 42, docs/bootstrap.md): `get --bootstrap <recipe.json | @name>` and
// `bootstrap --lease <id> <recipe>`. The recipe is read, and every step it names prepared (the backup found, each code
// source planned against the guards, each import checked against the flavor's engine, aras-pkg and git found) before a
// slot is reserved, so a bad path costs no lease. Then the steps run in their fixed order, each one skipped when its
// section is absent and every one after a failure reported as not reached: restore (inside `getLease`, at `get`), code
// (ticket 40), import (ticket 41), git (ticket 53), and a health check of the slot from WSL. Each step's time and log go
// in the report; the logs are in `<home>/logs/`, and none holds a secret.

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CODE_SUBPATH } from "../core/code-deploy.js";
import type { FlavorKey } from "../core/flavors.js";
import { UsageError, type RestoreRequest } from "../core/lease.js";
import { BOOTSTRAP_STEPS, MAX_RECIPE_BYTES, RECIPE_NAME, parseRecipeText, recipeFlavor, type BootstrapStepName, type Recipe } from "../core/recipe.js";
import { redact } from "../core/redact.js";
import type { StateStore } from "../core/store.js";
import type { HostDriver } from "../host/driver.js";
import { deployCodeOnLease, planSource, type CodeOutcome, type CodeRules, type PlannedSource } from "./code.js";
import { assertNoGitTargets, gitBaselineOnLease, type GitOutcome, type GitTool } from "./git.js";
import type { LeaseProbe } from "./host.js";
import { prepareImports, requireArasPkg, runImports, type ImportDeps, type ImportResult, type PreparedImport } from "./import.js";
import { resolveRestoreSource } from "./restore.js";
import { callerPath } from "../host/platform.js";

/** `--bootstrap @<name>` is `<home>/recipes/<name>.json`. */
export const RECIPES_FOLDER = "recipes";

/** A recipe read from its file. Relative paths in it are relative to `dir`. */
export interface LoadedRecipe {
  readonly recipe: Recipe;
  /** The recipe file's absolute path; what the report names it by. */
  readonly path: string;
  readonly dir: string;
}

/** The recipe file `spec` names: `@<name>` in `<home>/recipes/`, a Windows drive path, or a path from `cwd`. */
export function recipePath(spec: string, home: string, cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (spec.startsWith("@")) {
    const name = spec.slice(1);
    if (!RECIPE_NAME.test(name)) throw new UsageError(`--bootstrap ${spec.slice(0, 80)}: a recipe name is letters, digits, '.', '_' and '-'`);
    return join(home, RECIPES_FOLDER, `${name}.json`);
  }
  if (spec.trim() === "") throw new UsageError("--bootstrap needs a recipe file, or @<name> for one in the recipes folder");
  return callerPath(spec, { cwd, env });
}

export async function loadRecipe(spec: string, home: string, cwd?: string): Promise<LoadedRecipe> {
  const path = recipePath(spec, home, cwd);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new UsageError(`the recipe ${path} is not a file${spec.startsWith("@") ? ` (recipes named with @ are in ${join(home, RECIPES_FOLDER)})` : ""}`);
  if (info.size > MAX_RECIPE_BYTES) throw new UsageError(`the recipe ${path} is larger than ${MAX_RECIPE_BYTES} bytes`);
  return { recipe: parseRecipeText(await readFile(path, "utf8"), path), path, dir: dirname(path) };
}

/** One `code` entry planned, with its own rules. */
export interface PlannedCode {
  readonly source: PlannedSource;
  readonly rules: CodeRules;
}

/** A recipe with everything it names found and checked, for one flavor. */
export interface PreparedRecipe {
  readonly path: string;
  readonly flavor: FlavorKey;
  readonly restore?: RestoreRequest;
  readonly code: readonly PlannedCode[];
  readonly imports: readonly PreparedImport[];
  readonly git: boolean;
  readonly agent: boolean;
  readonly atomic: boolean;
}

/**
 * Finds and checks what the recipe names, as `get --restore`, `--code` and `--import` do before a lease is taken: the
 * backup, each code source against the guards (a `GuardError`, exit 7), each import against the flavor's engine, and
 * aras-pkg when there is an import. `given` is the command's flavor (or the lease's); the recipe's must agree with it.
 */
export async function prepareRecipe(loaded: LoadedRecipe, given: string | undefined, context: { readonly env: NodeJS.ProcessEnv; readonly verbose: boolean }): Promise<PreparedRecipe> {
  const { recipe, dir, path } = loaded;
  const flavor = recipeFlavor(recipe, given, path);
  const restore = recipe.restore
    ? await resolveRestoreSource(flavor, recipe.restore.from, {
        cwd: dir,
        allowForeignOrigin: recipe.restore.allowForeignOrigin,
        skipVersionCheck: recipe.restore.skipVersionCheck,
        media: { env: context.env },
      })
    : undefined;
  const code: PlannedCode[] = [];
  for (const entry of recipe.code) {
    const rules = { allowConfig: entry.allowConfig, allowServers: entry.allowServers };
    // The subpath always given, so a colon in the source's own path is never read as the separator.
    code.push({ source: await planSource(`${entry.from}:${entry.to ?? DEFAULT_CODE_SUBPATH}`, rules, dir), rules });
  }
  const imports = prepareImports(
    recipe.import.map((i) => ({ given: i.manifest, options: i.options, packages: i.packages })),
    { flavor, env: context.env, cwd: dir, verbose: context.verbose },
  );
  if (imports.length > 0) requireArasPkg(context.env);
  return { path, flavor, ...(restore ? { restore } : {}), code, imports, git: recipe.git, agent: recipe.agent, atomic: recipe.atomic };
}

/** The git baseline cannot be made over a code entry that writes its place (ticket 53). */
export function assertRecipeGit(prepared: PreparedRecipe): void {
  assertNoGitTargets(prepared.code.map((c) => c.source));
}

/** One step of the report (docs/schemas/get.schema.json, `bootstrap.steps`). */
export interface StepReport {
  readonly name: BootstrapStepName;
  readonly status: "ok" | "failed" | "skipped";
  /** True only when the step ran and passed. */
  readonly ok: boolean;
  readonly ms: number;
  /** The step's log: the import's own aras-pkg log, the bootstrap log for the others; null for a step that did not run. */
  readonly log: string | null;
  readonly detail: string;
}

/** The bootstrap log of a lease: `<home>/logs/<lease_id>-bootstrap.log`, appended to, one line per step. */
export function bootstrapLogPath(home: string, leaseId: string): string {
  return join(home, "logs", `${leaseId}-bootstrap.log`);
}

/** Collects the step reports and writes each one, redacted, to the lease's bootstrap log. */
export class StepRecorder {
  readonly steps: StepReport[] = [];

  constructor(
    private readonly home: string,
    private readonly leaseId: string,
  ) {}

  get log(): string {
    return bootstrapLogPath(this.home, this.leaseId);
  }

  /** The step that failed, if one did. */
  get failed(): StepReport | undefined {
    return this.steps.find((s) => s.status === "failed");
  }

  has(name: BootstrapStepName): boolean {
    return this.steps.some((s) => s.name === name);
  }

  async record(name: BootstrapStepName, status: StepReport["status"], ms: number, detail: string, options: { readonly log?: string; readonly lines?: readonly string[] } = {}): Promise<StepReport> {
    const shown = redact(detail);
    const ran = status !== "skipped";
    const step: StepReport = { name, status, ok: status === "ok", ms: Math.max(0, Math.round(ms)), log: ran ? (options.log ?? this.log) : null, detail: shown };
    this.steps.push(step);
    if (ran) {
      await mkdir(dirname(this.log), { recursive: true, mode: 0o700 });
      const text = [`${new Date().toISOString()} ${name} ${status} in ${step.ms} ms: ${shown}`, ...(options.lines ?? []).map((l) => `  ${redact(l)}`)].join("\n");
      await appendFile(this.log, `${text}\n`, { mode: 0o600 });
    }
    return step;
  }

  /** Marks every step not yet reported: not in the recipe, or not reached after the one that failed. */
  async skipRest(prepared: PreparedRecipe, extra: { readonly git?: string } = {}): Promise<void> {
    const failed = this.failed;
    const after = (name: BootstrapStepName) => failed !== undefined && BOOTSTRAP_STEPS.indexOf(name) > BOOTSTRAP_STEPS.indexOf(failed.name);
    for (const name of BOOTSTRAP_STEPS) {
      if (this.has(name)) continue;
      if (failed !== undefined && after(name)) await this.record(name, "skipped", 0, `not reached: the ${failed.name} step failed`);
      else if (!inRecipe(prepared, name)) await this.record(name, "skipped", 0, "not in the recipe");
      else if (name === "git" && extra.git !== undefined) await this.record(name, "skipped", 0, extra.git);
      else await this.record(name, "skipped", 0, "not run");
    }
  }
}

function inRecipe(prepared: PreparedRecipe, name: BootstrapStepName): boolean {
  switch (name) {
    case "restore":
      return prepared.restore !== undefined;
    case "code":
      return prepared.code.length > 0;
    case "import":
      return prepared.imports.length > 0;
    case "git":
      return prepared.git;
    case "health":
      return true;
  }
}

/** The lease the steps run on. */
export interface BootstrapTarget {
  readonly slot: string;
  readonly leaseId: string;
  readonly flavor: FlavorKey;
  /** The lease has its agent: a deploy starts it again. */
  readonly agent: boolean;
  readonly url: string;
  readonly database: string;
}

export interface BootstrapDeps {
  readonly store: StateStore;
  readonly host: Pick<HostDriver, "deployCode">;
  readonly localRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly probe: (url: string, database: string) => Promise<LeaseProbe>;
  /** Present when the recipe imports. */
  readonly imports?: ImportDeps;
  /** Present when the recipe makes a git baseline and the lease has none. */
  readonly git?: GitTool;
  /** Restores the recipe's backup over a lease already held (`bootstrap --lease`); `get` restores inside `getLease`. */
  readonly restoreHeld?: (restore: RestoreRequest) => Promise<string>;
}

/** What the steps did, for the report. */
export interface BootstrapResult {
  readonly steps: readonly StepReport[];
  readonly failed?: StepReport;
  readonly code?: readonly CodeOutcome[];
  readonly imports?: readonly ImportResult[];
  readonly git?: GitOutcome;
  /** The lease's bootstrap log. */
  readonly log: string;
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the recipe's steps on the lease in order, after what `recorder` already holds (the restore, at `get`): each runs
 * only when every step before it passed. It never throws for a step's failure; the result names the step that failed.
 * The caller decides what becomes of the lease. `gitSkipped` reports the git step as skipped with that reason.
 */
export async function runBootstrap(deps: BootstrapDeps, target: BootstrapTarget, prepared: PreparedRecipe, recorder: StepRecorder, options: { readonly gitSkipped?: string } = {}): Promise<BootstrapResult> {
  let code: CodeOutcome[] | undefined;
  let imports: readonly ImportResult[] | undefined;
  let git: GitOutcome | undefined;
  const go = (name: BootstrapStepName) => recorder.failed === undefined && !recorder.has(name) && inRecipe(prepared, name);

  if (go("restore") && deps.restoreHeld && prepared.restore) {
    const restore = prepared.restore;
    const started = performance.now();
    try {
      const detail = await deps.restoreHeld(restore);
      await recorder.record("restore", "ok", performance.now() - started, detail);
    } catch (err) {
      await recorder.record("restore", "failed", performance.now() - started, message(err));
    }
  }

  if (go("code")) {
    code = [];
    const started = performance.now();
    let ok = true;
    for (const entry of prepared.code) {
      const report = await deployCodeOnLease({ store: deps.store, host: deps.host, localRoot: deps.localRoot }, { slot: target.slot, leaseId: target.leaseId, agent: target.agent }, [entry.source], entry.rules);
      code.push(...report.outcomes);
      if (!report.ok) {
        ok = false;
        break;
      }
    }
    const last = code.at(-1);
    const files = code.reduce((n, o) => n + o.files, 0);
    await recorder.record("code", ok ? "ok" : "failed", performance.now() - started, ok ? `${code.length} deploy${code.length === 1 ? "" : "s"}, ${files} files` : `the deploy of ${last?.source ?? "?"} failed: ${last?.detail ?? "no detail"}`, {
      lines: code.map((o) => `${o.source} -> ${o.subpath === "" ? "." : o.subpath}: ${o.ok ? "ok" : "failed"}, ${o.files} files, ${o.deleted} deleted (${o.detail})`),
    });
  }

  if (go("import") && deps.imports) {
    const started = performance.now();
    try {
      const run = await runImports(deps.imports, target.leaseId, prepared.imports);
      imports = run.results;
      const log = run.results.at(-1)?.log;
      await recorder.record("import", run.failure === undefined ? "ok" : "failed", performance.now() - started, run.failure ?? `${run.results.length} import${run.results.length === 1 ? "" : "s"}`, log === undefined ? {} : { log });
    } catch (err) {
      await recorder.record("import", "failed", performance.now() - started, message(err));
    }
  }

  if (go("git") && options.gitSkipped === undefined && deps.git) {
    const { value, ms } = await timed(() =>
      gitBaselineOnLease({ store: deps.store, host: deps.host, git: deps.git!, localRoot: deps.localRoot, env: deps.env }, { slot: target.slot, leaseId: target.leaseId, flavor: target.flavor, agent: target.agent }),
    );
    git = value.outcome;
    await recorder.record("git", git.ok ? "ok" : "failed", ms, git.detail);
  }

  if (go("health")) {
    const probe = await deps.probe(target.url, target.database);
    await recorder.record("health", probe.ok ? "ok" : "failed", probe.ms, probe.detail);
  }

  await recorder.skipRest(prepared, options.gitSkipped === undefined ? {} : { git: options.gitSkipped });
  const failed = recorder.failed;
  return {
    steps: BOOTSTRAP_STEPS.map((name) => recorder.steps.find((s) => s.name === name)!),
    ...(failed ? { failed } : {}),
    ...(code ? { code } : {}),
    ...(imports ? { imports } : {}),
    ...(git ? { git } : {}),
    log: recorder.log,
  };
}

/** The `bootstrap` object of the JSON contract: the recipe, every step, and what the code and git steps did. */
export function bootstrapJson(prepared: PreparedRecipe, result: BootstrapResult): Record<string, unknown> {
  return {
    recipe: prepared.path,
    steps: result.steps,
    ...(result.code ? { code: result.code } : {}),
    ...(result.git ? { git: result.git } : {}),
  };
}

/** The human lines: one per step. */
export function formatSteps(steps: readonly StepReport[]): string[] {
  return steps.map((s) => `${`${s.name}:`.padEnd(10)} ${s.status}${s.status === "skipped" ? "" : ` in ${(s.ms / 1000).toFixed(1)} s`} (${s.detail})`);
}

/** The one line a failed bootstrap ends with: the step, its detail and its log. */
export function failureLine(failed: StepReport): string {
  // An import's detail already names its log.
  const log = failed.log !== null && failed.detail.includes(failed.log) ? "" : `; its log: ${failed.log ?? "none"}`;
  return `the bootstrap's ${failed.name} step failed (${failed.detail})${log}`;
}
