// A bootstrap recipe (ticket 42, docs/bootstrap.md): the whole bring-up of a lease in one JSON file, "like a worktree
// populated from a branch". `arashouse get <flavor> --bootstrap <recipe.json>` (or `@name`, from `<home>/recipes/`) and
// `arashouse bootstrap --lease <id> <recipe>` read it. This module checks its shape only: no file is opened and no path
// resolved here (the CLI does that, relative to the recipe file). A recipe holds no secret, so a key that names one
// (`password`, `key`, `token`, `secret`, ...) is refused wherever it is, before anything else is read.

import { isFlavorKey, FLAVOR_KEYS, type FlavorKey } from "./flavors.js";
import { UsageError } from "./lease.js";
import { SECRET_KEY } from "./state.js";

/** The largest recipe file read. */
export const MAX_RECIPE_BYTES = 1024 * 1024;

/** A recipe named `@<name>` is `<home>/recipes/<name>.json`. */
export const RECIPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The steps, in the fixed order they run: each assumes the ones before it (docs/bootstrap.md). */
export const BOOTSTRAP_STEPS = ["restore", "code", "import", "git", "health"] as const;
export type BootstrapStepName = (typeof BOOTSTRAP_STEPS)[number];

export interface RecipeRestore {
  /** A backup file or a profile name, as `get --restore` takes it. */
  readonly from: string;
  readonly allowForeignOrigin: boolean;
  readonly skipVersionCheck: boolean;
}

export interface RecipeCode {
  /** A folder or zip, as `get --code` takes it. */
  readonly from: string;
  /** Where it lands in the slot's tree; absent for the default (`Innovator`). */
  readonly to?: string;
  readonly allowConfig: boolean;
  readonly allowServers: boolean;
}

/** One import, in the shape of `get --import`'s options (their command-line names). */
export interface RecipeImport {
  readonly manifest: string;
  readonly options: Readonly<Record<string, string | true>>;
  readonly packages: readonly string[];
}

export interface Recipe {
  readonly flavor?: FlavorKey;
  readonly restore?: RecipeRestore;
  readonly code: readonly RecipeCode[];
  readonly import: readonly RecipeImport[];
  /** Make the slot's `Innovator\` tree a git baseline (ticket 53), after the imports. */
  readonly git: boolean;
  /** Start the slot's agent service (`get --agent`). */
  readonly agent: boolean;
  /** A failed step gives the lease back (the default); false keeps it, as `--keep-on-fail` does. */
  readonly atomic: boolean;
}

type Json = Readonly<Record<string, unknown>>;

/** Every key path in `value` that names a secret, as `a.b[0].c`. */
function secretKeys(value: unknown, at: string, found: string[]): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => secretKeys(v, `${at}[${i}]`, found));
  else if (typeof value === "object" && value !== null) {
    for (const [key, v] of Object.entries(value)) {
      const path = at === "" ? key : `${at}.${key}`;
      if (SECRET_KEY.test(key)) found.push(path.slice(0, 120));
      secretKeys(v, path, found);
    }
  }
  return found;
}

class Reader {
  constructor(private readonly label: string) {}

  fail(detail: string): never {
    throw new UsageError(`recipe ${this.label}: ${detail}`);
  }

  object(value: unknown, at: string, keys: readonly string[]): Json {
    if (typeof value !== "object" || value === null || Array.isArray(value)) this.fail(`${at} must be a JSON object`);
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) this.fail(`${at} has no "${key.slice(0, 40)}" (it takes ${keys.map((k) => `"${k}"`).join(", ")})`);
    }
    return value as Json;
  }

  text(value: unknown, at: string): string {
    if (typeof value !== "string" || value.trim() === "" || value.length > 1000) this.fail(`${at} must be a non-empty string`);
    return value;
  }

  optionalText(value: unknown, at: string): string | undefined {
    return value === undefined ? undefined : this.text(value, at);
  }

  flag(value: unknown, at: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") this.fail(`${at} must be true or false`);
    return value;
  }

  list(value: unknown, at: string): readonly unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) this.fail(`${at} must be a list`);
    return value;
  }
}

const TOP_KEYS = ["flavor", "restore", "code", "import", "git", "agent", "atomic"];
const RESTORE_KEYS = ["from", "allow_foreign_origin", "skip_version_check"];
const CODE_KEYS = ["from", "to", "allow_config", "allow_servers"];
const IMPORT_KEYS = ["manifest", "merge", "release", "description", "packages", "os_user", "languages", "collect_errors", "batch", "timeout", "engine", "skip_version_check"];

function readRestore(r: Reader, value: unknown): RecipeRestore {
  if (typeof value === "string") return { from: r.text(value, "restore"), allowForeignOrigin: false, skipVersionCheck: false };
  const o = r.object(value, "restore", RESTORE_KEYS);
  return {
    from: r.text(o.from, "restore.from"),
    allowForeignOrigin: r.flag(o.allow_foreign_origin, "restore.allow_foreign_origin", false),
    skipVersionCheck: r.flag(o.skip_version_check, "restore.skip_version_check", false),
  };
}

function readCode(r: Reader, value: unknown, at: string): RecipeCode {
  const o = r.object(value, at, CODE_KEYS);
  const to = r.optionalText(o.to, `${at}.to`);
  return {
    from: r.text(o.from, `${at}.from`),
    ...(to === undefined ? {} : { to }),
    allowConfig: r.flag(o.allow_config, `${at}.allow_config`, false),
    allowServers: r.flag(o.allow_servers, `${at}.allow_servers`, false),
  };
}

function readImport(r: Reader, value: unknown, at: string): RecipeImport {
  const o = r.object(value, at, IMPORT_KEYS);
  const options: Record<string, string | true> = {};
  if (o.merge !== undefined) options[r.flag(o.merge, `${at}.merge`, false) ? "merge" : "no-merge"] = true;
  for (const [key, name] of [["release", "release"], ["description", "description"], ["os_user", "os-user"], ["languages", "languages"], ["engine", "engine"]] as const) {
    const text = r.optionalText(o[key], `${at}.${key}`);
    if (text !== undefined) options[name] = text;
  }
  for (const [key, name] of [["collect_errors", "collect-errors"], ["batch", "batch"], ["skip_version_check", "skip-version-check"]] as const) {
    if (r.flag(o[key], `${at}.${key}`, false)) options[name] = true;
  }
  if (o.timeout !== undefined) {
    if (typeof o.timeout !== "number" || !Number.isInteger(o.timeout) || o.timeout < -1) r.fail(`${at}.timeout must be a whole number of milliseconds (0 the engine's default, -1 for ever)`);
    options.timeout = String(o.timeout);
  }
  const packages = r.list(o.packages, `${at}.packages`).map((p, i) => r.text(p, `${at}.packages[${i}]`));
  return { manifest: r.text(o.manifest, `${at}.manifest`), options, packages };
}

/**
 * Checks a parsed recipe and returns it with its defaults (`atomic` true, `git` and `agent` false). `label` names the
 * recipe in errors. Throws a `UsageError` for a key that names a secret (never quoting its value), an unknown key, or a
 * value of the wrong kind; an empty recipe is valid (a lease with a health check only).
 */
export function parseRecipe(value: unknown, label: string): Recipe {
  const r: Reader = new Reader(label);
  const secrets = secretKeys(value, "", []);
  if (secrets.length > 0) r.fail(`${secrets.join(", ")} looks like a secret, and a recipe holds none (the lease's password is made at get)`);
  const o = r.object(value, "the recipe", TOP_KEYS);
  let flavor: FlavorKey | undefined;
  if (o.flavor !== undefined) {
    if (!isFlavorKey(o.flavor)) r.fail(`flavor must be one of ${FLAVOR_KEYS.join(", ")}`);
    flavor = o.flavor;
  }
  return {
    ...(flavor === undefined ? {} : { flavor }),
    ...(o.restore === undefined ? {} : { restore: readRestore(r, o.restore) }),
    code: r.list(o.code, "code").map((c, i) => readCode(r, c, `code[${i}]`)),
    import: r.list(o.import, "import").map((m, i) => readImport(r, m, `import[${i}]`)),
    git: r.flag(o.git, "git", false),
    agent: r.flag(o.agent, "agent", false),
    atomic: r.flag(o.atomic, "atomic", true),
  };
}

/** The recipe text parsed and checked; JSON that does not parse is a `UsageError` naming the recipe. */
export function parseRecipeText(text: string, label: string): Recipe {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new UsageError(`recipe ${label}: not JSON (${(err as Error).message.slice(0, 200)})`);
  }
  return parseRecipe(value, label);
}

/** The flavor a recipe runs on: the command's and the recipe's must agree, and one of them must name it. */
export function recipeFlavor(recipe: Recipe, given: string | undefined, label: string): FlavorKey {
  if (given !== undefined && !isFlavorKey(given)) throw new UsageError(`unknown flavor "${given}"; the flavors are ${FLAVOR_KEYS.join(", ")}`);
  if (given !== undefined && recipe.flavor !== undefined && given !== recipe.flavor) {
    throw new UsageError(`recipe ${label} is for flavor ${recipe.flavor}, not ${given}`);
  }
  const flavor = given ?? recipe.flavor;
  if (flavor === undefined) throw new UsageError(`recipe ${label} names no flavor: give one (get <flavor> --bootstrap ...) or put "flavor" in it`);
  return flavor;
}
