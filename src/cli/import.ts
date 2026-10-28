// Bootstrap step 3 (ticket 41): package imports onto a lease with import-export-libs-js's `aras-pkg import`, for
// `arashouse get <flavor> --import <manifest|folder> [options] ...` and `arashouse import --lease <id> ...`. Each import is
// a child process started as `run` starts one (run.ts): the password reaches it only as `ARAS_PASSWORD` in its
// environment, never as a flag or a file; the libs-js CLI has no password flag. The engine is the flavor's (the flavor
// registry), passed as `--engine`, so a stray `ARAS_PKG_ENGINE` cannot pick another. Its log goes to
// `<ARASHOUSE_HOME>/logs/<lease_id>-import-<n>.log`; libs-js never writes a password to it ("Connection and credentials").
// Everything here is checked before a lease is taken, so a mistake costs no slot.

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { FLAVORS, getFlavor, type FlavorKey } from "../core/flavors.js";
import { UsageError } from "../core/lease.js";
import { redact } from "../core/redact.js";
import type { OptionKind } from "./args.js";
import { leaseEnvironment, runChild, type RunDeps } from "./run.js";

/** A path to the libs-js CLI (a checkout's `dist/cli.js`, or an executable); else `aras-pkg` on `PATH`. */
export const APKG_ENV = "ARASHOUSE_APKG";

/** The engine that alone takes `--languages`, `--collect-errors` and `--batch` (libs-js's CLI refuses them on the others). */
export const ENGINE_1435 = "14.35";

/** The engines arashouse knows, from the flavor registry. */
export const KNOWN_ENGINES: readonly string[] = [...new Set(Object.values(FLAVORS).map((f) => f.libsJsEngine))];

/** The options that belong to one import; `--package` is the one that may be given more than once. */
const IMPORT_OPTIONS: Readonly<Record<string, OptionKind>> = {
  merge: "flag",
  "no-merge": "flag",
  release: "value",
  description: "value",
  package: "value",
  "os-user": "value",
  languages: "value",
  "collect-errors": "flag",
  batch: "flag",
  "skip-version-check": "flag",
  timeout: "value",
  engine: "value",
};

/** One import as typed: its manifest (or package folder) and its own options. */
export interface ImportStep {
  readonly given: string;
  readonly options: Readonly<Record<string, string | true>>;
  readonly packages: readonly string[];
}

export interface SplitImports {
  /** The command's own arguments, in order, for `parseArgs`. */
  readonly rest: readonly string[];
  readonly steps: readonly ImportStep[];
}

/**
 * Takes the imports out of a command line. With `starts: "--import"` (`get`) each `--import <manifest>` starts an import;
 * with `starts: "positional"` (`import`) each argument that is not an option does. The import options that follow belong
 * to that import, up to the next one. Everything else is left in `rest`, with the values of the command's own options
 * (`outer`), so `get 23 --import a --merge --holder x` gives `rest` = `23 --holder x`.
 */
export function splitImports(args: readonly string[], outer: Readonly<Record<string, OptionKind>>, starts: "--import" | "positional"): SplitImports {
  const rest: string[] = [];
  const steps: { given: string; options: Record<string, string | true>; packages: string[] }[] = [];
  const begin = (given: string) => {
    if (given === "") throw new UsageError("an import needs a manifest (imports.mf) or the folder that holds one");
    steps.push({ given, options: {}, packages: [] });
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") ? (eq === -1 ? arg.slice(2) : arg.slice(2, eq)) : undefined;
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = (): string => {
      if (inline !== undefined) return inline;
      const value = args[i + 1];
      if (value === undefined || value === "--") throw new UsageError(`--${name} needs a value`);
      i++;
      return value;
    };
    if (starts === "--import" && name === "import") {
      begin(next());
      continue;
    }
    if (name === undefined) {
      if (starts === "positional" && !arg.startsWith("-")) begin(arg);
      else rest.push(arg);
      continue;
    }
    const kind = IMPORT_OPTIONS[name];
    if (kind === undefined) {
      rest.push(arg);
      // The command's own value option keeps its value, so a value that looks like an import option is not read as one.
      if ((outer[name] === "value" || outer[name] === "list") && inline === undefined && i + 1 < args.length && args[i + 1] !== "--") rest.push(args[++i]!);
      continue;
    }
    const step = steps.at(-1);
    if (step === undefined) {
      throw new UsageError(`--${name} belongs to an import: put it after the ${starts === "--import" ? "--import <manifest>" : "<manifest>"} it is for`);
    }
    if (kind === "flag") {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      if (Object.hasOwn(step.options, name)) throw new UsageError(`--${name} given twice for the import of ${step.given}`);
      step.options[name] = true;
    } else if (name === "package") {
      step.packages.push(next());
    } else {
      if (Object.hasOwn(step.options, name)) throw new UsageError(`--${name} given twice for the import of ${step.given}`);
      step.options[name] = next();
    }
  }
  return { rest, steps };
}

/** An import checked against the lease's flavor: its manifest's absolute path, its engine and the arguments for `aras-pkg`. */
export interface PreparedImport {
  readonly given: string;
  readonly manifest: string;
  readonly engine: string;
  /** What follows `aras-pkg import <manifest>`, without the connection and the log, which are the lease's. */
  readonly args: readonly string[];
}

/** The manifest a step names: the file itself, or `imports.mf` in the folder; an absolute path. */
function manifestPath(given: string, cwd: string): string {
  const path = isAbsolute(given) ? given : resolve(cwd, given);
  if (!existsSync(path)) throw new UsageError(`the import manifest ${given} does not exist`);
  if (statSync(path).isDirectory()) {
    const inFolder = join(path, "imports.mf");
    if (!existsSync(inFolder) || !statSync(inFolder).isFile()) throw new UsageError(`the folder ${given} holds no imports.mf`);
    return inFolder;
  }
  return path;
}

/**
 * Checks each import against the flavor, as libs-js's CLI would, before anything is sent: the 14.35-only options on another
 * engine, `--skip-version-check` (an engine run against a server outside its window is a bug here, so it needs an explicit
 * `--engine`), and an `ARAS_PKG_ENGINE` in the caller's environment that is not the flavor's engine.
 */
export function prepareImports(steps: readonly ImportStep[], context: { readonly flavor: FlavorKey; readonly env: NodeJS.ProcessEnv; readonly cwd?: string; readonly verbose?: boolean }): PreparedImport[] {
  const flavorEngine = getFlavor(context.flavor).libsJsEngine;
  const inherited = context.env.ARAS_PKG_ENGINE;
  return steps.map((step) => {
    const o = step.options;
    const explicit = typeof o.engine === "string" ? o.engine : undefined;
    if (explicit !== undefined && !KNOWN_ENGINES.includes(explicit)) throw new UsageError(`--engine must be one of ${KNOWN_ENGINES.join(", ")}, not "${explicit}"`);
    if (explicit === undefined && inherited !== undefined && inherited !== "" && inherited !== flavorEngine) {
      throw new UsageError(
        `ARAS_PKG_ENGINE is ${inherited} in this environment, but a ${context.flavor} lease takes engine ${flavorEngine}; unset it, or give the import --engine ${inherited} to mean it`,
      );
    }
    const engine = explicit ?? flavorEngine;
    if (o.merge === true && o["no-merge"] === true) throw new UsageError(`--merge and --no-merge both given for the import of ${step.given}`);
    if (engine !== ENGINE_1435) {
      for (const name of ["languages", "collect-errors", "batch"]) {
        if (Object.hasOwn(o, name)) throw new UsageError(`--${name} is for engine ${ENGINE_1435} only; a ${context.flavor} import runs engine ${engine}`);
      }
    }
    if (o["skip-version-check"] === true && explicit === undefined) {
      throw new UsageError(`--skip-version-check is refused: engine ${engine} serves ${context.flavor}, so a server outside its window is a bug; give --engine too to mean it`);
    }
    if (typeof o.timeout === "string" && !/^-?\d+$/.test(o.timeout)) throw new UsageError(`--timeout must be a whole number of milliseconds (0 keeps the engine's default, -1 waits for ever)`);
    const manifest = manifestPath(step.given, context.cwd ?? process.cwd());

    const args: string[] = ["--engine", engine];
    if (o.merge === true) args.push("--merge");
    if (o["no-merge"] === true) args.push("--no-merge");
    for (const name of ["release", "description", "os-user", "languages"]) {
      const value = o[name];
      if (typeof value === "string") args.push(`--${name}`, value);
    }
    for (const name of step.packages) args.push("--package", name);
    for (const name of ["collect-errors", "batch", "skip-version-check"]) if (o[name] === true) args.push(`--${name}`);
    // The `=` form: libs-js reads `--timeout -1` as a missing value.
    if (typeof o.timeout === "string") args.push(`--timeout=${o.timeout}`);
    if (context.verbose === true) args.push("--verbose");
    return { given: step.given, manifest, engine, args };
  });
}

/** Where `aras-pkg` comes from: `ARASHOUSE_APKG`, else `PATH`. */
export interface ArasPkg {
  readonly source: typeof APKG_ENV | "PATH";
  readonly path: string;
  /** The program to start, and the arguments before the command's own (`node <cli.js>` for a script). */
  readonly program: string;
  readonly prefix: readonly string[];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The libs-js CLI to run, or null when there is none; an `ARASHOUSE_APKG` that names nothing is an error. */
export function findArasPkg(env: NodeJS.ProcessEnv): ArasPkg | null {
  const named = env[APKG_ENV];
  if (named !== undefined && named !== "") {
    const path = resolve(named);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${APKG_ENV} is ${named}, which is not a file; point it at the libs-js CLI (a checkout's dist/cli.js)`);
    return /\.[cm]?js$/.test(path) ? { source: APKG_ENV, path, program: process.execPath, prefix: [path] } : { source: APKG_ENV, path, program: path, prefix: [] };
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, "aras-pkg");
    if (isExecutable(path)) return { source: "PATH", path, program: path, prefix: [] };
  }
  return null;
}

/** As `findArasPkg`, but an import cannot run without it. */
export function requireArasPkg(env: NodeJS.ProcessEnv): ArasPkg {
  const found = findArasPkg(env);
  if (found === null) throw new Error(`aras-pkg (import-export-libs-js) is not on PATH; install it, or set ${APKG_ENV} to a checkout's dist/cli.js`);
  return found;
}

/** `aras-pkg --version`, trimmed; rejects when it does not run. */
export function arasPkgVersion(apkg: ArasPkg, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    execFile(apkg.program, [...apkg.prefix, "--version"], { env, encoding: "utf8", timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolveVersion(stdout.trim());
    });
  });
}

/** `doctor`'s line for the import tool: found or not, from where, and its version. */
export async function describeArasPkg(env: NodeJS.ProcessEnv): Promise<{ readonly found: boolean; readonly detail: string }> {
  let apkg: ArasPkg | null;
  try {
    apkg = findArasPkg(env);
  } catch (err) {
    return { found: false, detail: (err as Error).message };
  }
  if (apkg === null) return { found: false, detail: `not on PATH and ${APKG_ENV} is not set; needed only for get --import and import` };
  const version = await arasPkgVersion(apkg, env).then(
    (v) => `version ${v}`,
    (err: NodeJS.ErrnoException) => `but \`--version\` failed (${err.code ?? err.message})`,
  );
  return { found: true, detail: `${apkg.path} (from ${apkg.source}), ${version}` };
}

/** What one import did. `exit_code` is aras-pkg's: 0 done, 1 failed, 2 done with errors the engine reported, 64 usage. */
export interface ImportResult {
  readonly manifest: string;
  readonly exit_code: number;
  readonly log: string;
}

export interface ImportDeps extends Pick<RunDeps, "store" | "secrets" | "resolveUrl" | "err"> {
  /** The environment the child starts from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly apkg: ArasPkg;
  /** The state folder; logs go to its `logs/`. */
  readonly home: string;
}

export interface ImportRun {
  readonly results: readonly ImportResult[];
  /** The first import that failed, as one line; the ones after it were not run. */
  readonly failure?: string;
}

/** The next free `<lease_id>-import-<n>.log`, so a later `arashouse import` on the lease does not overwrite an earlier log. */
async function nextLogNumber(dir: string, leaseId: string): Promise<number> {
  const pattern = new RegExp(`^${leaseId}-import-(\\d+)\\.log$`);
  let highest = 0;
  for (const name of await readdir(dir)) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** The lease's flavor, from the state; the lease must be held. */
export async function leaseFlavor(deps: Pick<RunDeps, "store" | "secrets" | "resolveUrl">, leaseId: string): Promise<FlavorKey> {
  return (await leaseEnvironment(deps, leaseId)).ARASHOUSE_FLAVOR as FlavorKey;
}

/** Runs the imports in order onto the lease, and stops at the first that fails. */
export async function runImports(deps: ImportDeps, leaseId: string, imports: readonly PreparedImport[]): Promise<ImportRun> {
  const lease = await leaseEnvironment(deps, leaseId);
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env), ...lease };
  const logs = join(deps.home, "logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const results: ImportResult[] = [];
  for (const [index, step] of imports.entries()) {
    const log = join(logs, `${leaseId}-import-${await nextLogNumber(logs, leaseId)}.log`);
    const args = [
      ...deps.apkg.prefix,
      "import",
      step.manifest,
      "--url",
      lease.ARAS_URL,
      "--database",
      lease.ARAS_DATABASE,
      "--user",
      lease.ARAS_USER,
      "--log",
      log,
      ...step.args,
    ];
    const label = `import ${index + 1} of ${imports.length} (${step.given}, engine ${step.engine})`;
    deps.err(`arashouse: ${label} onto ${lease.ARASHOUSE_SLOT}`);
    const exit = await runChild(deps.apkg.program, args, { env, err: deps.err, output: (line) => deps.err(redact(line)) });
    results.push({ manifest: step.manifest, exit_code: exit, log });
    if (exit !== 0) return { results, failure: `${label} failed: aras-pkg exit ${exit}; its log: ${log}` };
    deps.err(`arashouse: ${label} done; its log: ${log}`);
  }
  return { results };
}
