// The pool's limits: `~/.arashouse/config.json` (next to the state file), every key optional, the
// defaults below in code. The captain's answer 1 ("3 most I would guess") makes the governor, not
// the slot count, what protects the laptop (ticket 17). The file holds limits only, never a secret:
// an unknown key is refused, so nothing else can be put there.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FLAVOR_KEYS, type FlavorKey, isFlavorKey } from "./flavors.js";
import { MAX_SLOT } from "./names.js";
import { resolveStorePaths } from "./store.js";

export interface ArashouseConfig {
  /** Leased slots allowed at once, all flavors. */
  readonly max_active: number;
  /** Resets allowed to run at once (a reset is I/O-bound on the laptop). */
  readonly max_resets: number;
  /** `get` hands out no slot while the host has less free RAM than this. */
  readonly min_free_ram_mb: number;
  /** A provision or a baseline build does not start with less free disk than this at the install root. */
  readonly min_free_disk_gb: number;
  /** How many slots of each flavor the pool is provisioned with (ticket 37). */
  readonly slots_per_flavor: Readonly<Record<FlavorKey, number>>;
}

/**
 * The defaults. `min_free_ram_mb` is one active slot's memory, the design's planning figure of about
 * 2 GB (OS and SQL are already running, so each active slot adds about 2 GB; ticket 06 measures the
 * real number and ticket 38 confirms it). `min_free_disk_gb` is about two slots' 4 to 5 GB each.
 */
export const DEFAULT_CONFIG: ArashouseConfig = {
  max_active: 3,
  max_resets: 2,
  min_free_ram_mb: 2048,
  min_free_disk_gb: 10,
  slots_per_flavor: { "12sp9": 3, "23": 2, "35": 2 },
};

export const CONFIG_FILE = "config.json";

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`the config file ${path} is unusable: ${detail}`);
    this.name = "ConfigError";
  }
}

const KEYS = ["max_active", "max_resets", "min_free_ram_mb", "min_free_disk_gb", "slots_per_flavor"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(path: string, key: string, value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ConfigError(path, `${key} must be a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? " up" : ` to ${max}`}`);
  }
  return value as number;
}

/** Parses a config file's text over the defaults; throws `ConfigError` naming the key at fault. */
export function parseConfig(text: string, path = CONFIG_FILE): ArashouseConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(path, "not valid JSON");
  }
  if (!isObject(raw)) throw new ConfigError(path, "not a JSON object");
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key)) throw new ConfigError(path, `unknown key "${key}"; the keys are ${KEYS.join(", ")}`);
  }
  const d = DEFAULT_CONFIG;
  let slots = d.slots_per_flavor;
  if (raw.slots_per_flavor !== undefined) {
    if (!isObject(raw.slots_per_flavor)) throw new ConfigError(path, "slots_per_flavor must be an object of flavor to count");
    const counts: Record<FlavorKey, number> = { ...d.slots_per_flavor };
    for (const [flavor, count] of Object.entries(raw.slots_per_flavor)) {
      if (!isFlavorKey(flavor)) throw new ConfigError(path, `slots_per_flavor names unknown flavor "${flavor}"; the flavors are ${FLAVOR_KEYS.join(", ")}`);
      counts[flavor] = integer(path, `slots_per_flavor.${flavor}`, count, 0, MAX_SLOT);
    }
    slots = counts;
  }
  return {
    max_active: raw.max_active === undefined ? d.max_active : integer(path, "max_active", raw.max_active, 1),
    max_resets: raw.max_resets === undefined ? d.max_resets : integer(path, "max_resets", raw.max_resets, 1),
    min_free_ram_mb: raw.min_free_ram_mb === undefined ? d.min_free_ram_mb : integer(path, "min_free_ram_mb", raw.min_free_ram_mb, 0),
    min_free_disk_gb: raw.min_free_disk_gb === undefined ? d.min_free_disk_gb : integer(path, "min_free_disk_gb", raw.min_free_disk_gb, 0),
    slots_per_flavor: slots,
  };
}

/** The config file's path under the state home (`$ARASHOUSE_HOME`, else `~/.arashouse`). */
export function configPath(options: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {}): string {
  return join(options.home ?? resolveStorePaths(options.env).home, CONFIG_FILE);
}

/** Reads the config; a missing file is the defaults. */
export async function loadConfig(options: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {}): Promise<ArashouseConfig> {
  const path = configPath(options);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw err;
  }
  return parseConfig(text, path);
}
