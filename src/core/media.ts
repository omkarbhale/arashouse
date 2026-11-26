// The media resolver: finds the folder that holds `<key>/` per flavor. `ARASHOUSE_MEDIA` first, then the `media` key
// of `config.json` (core/config.ts), then the main checkout's `media/`: a worktree is discarded at teardown and the
// installers are ignored by git, so the real files live only in the main checkout. The checkout is arashouse's only:
// a copy vendored into another repository (aras-mr-envs) never takes that repository's `media/`.
// This is local filesystem and git I/O, never Windows I/O.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigSync } from "./config.js";
import { getFlavor, type FlavorKey } from "./flavors.js";

/** Environment variable that replaces the `media/` folder (the one holding `<key>/` subfolders). */
export const MEDIA_ENV = "ARASHOUSE_MEDIA";

/**
 * Set by the WSL launcher on the Windows process: the `media/` of the arashouse checkout the launcher runs from, which
 * the Windows build (a runtime copy outside any checkout) cannot find itself. Used where the checkout's own would be:
 * after `ARASHOUSE_MEDIA` and config.json's `media`.
 */
export const CHECKOUT_MEDIA_ENV = "ARASHOUSE_CHECKOUT_MEDIA";

/** A missing media folder or file. The message says what to do; callers print it without a stack. */
export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export interface MediaOptions {
  /** Environment to read `ARASHOUSE_MEDIA` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Where to start looking for the repo: any directory inside a checkout or worktree of arashouse.
   * Defaults to the directory of this module, so the answer is the same whatever the caller's
   * working directory is (a worker runs `arashouse` from its own project's worktree) and for an
   * installed copy that is a link to a checkout.
   */
  startDir?: string;
  /** The `media` of `config.json`; read from the state home's config when not given (null: none). */
  configured?: string | null;
}

/** The package name of arashouse's own checkout; a git root whose `package.json` is another's is not it. */
const PACKAGE_NAME = "arashouse";

function packageName(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/** The config's `media`, or null; a config that cannot be read is no answer rather than an error here. */
function configuredMedia(options: MediaOptions, env: NodeJS.ProcessEnv): string | null {
  if (options.configured !== undefined) return options.configured;
  try {
    return loadConfigSync({ env }).media ?? null;
  } catch {
    return null;
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  // Set inside hooks and some wrappers; they would point git at a different repository.
  delete clean.GIT_DIR;
  delete clean.GIT_WORK_TREE;
  delete clean.GIT_COMMON_DIR;
  return clean;
}

/** The `media/` folder: `ARASHOUSE_MEDIA` if set, else the config's `media`, else the arashouse checkout's `media/`. */
export function resolveMediaRoot(options: MediaOptions = {}): string {
  const env = options.env ?? process.env;
  const startDir = resolve(options.startDir ?? moduleDir);
  const override = env[MEDIA_ENV];
  if (override !== undefined && override.trim() !== "") return resolve(startDir, override);
  const configured = configuredMedia(options, env);
  if (configured !== null) return configured;
  const launched = env[CHECKOUT_MEDIA_ENV]?.trim();
  if (launched) return launched;

  let common: string;
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: startDir,
      env: gitEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    common = resolve(startDir, out.trim());
  } catch {
    throw new MediaError(
      `cannot find the main checkout from ${startDir} (not inside a git checkout, or git is missing); ` +
        `set ${MEDIA_ENV}, or "media" in config.json, to the folder that holds the per-flavor media folders`,
    );
  }
  if (basename(common) !== ".git") {
    throw new MediaError(
      `the git common dir ${common} is not a ".git" folder, so the main checkout cannot be derived; set ${MEDIA_ENV}`,
    );
  }
  const checkout = dirname(common);
  if (packageName(checkout) !== PACKAGE_NAME) {
    throw new MediaError(
      `this arashouse is not in its own checkout (${checkout} is ${packageName(checkout) ?? "another repository"}'s, so it was copied in): ` +
        `set ${MEDIA_ENV}, or "media" in config.json, to the folder that holds the per-flavor media folders`,
    );
  }
  return join(checkout, "media");
}

/** The folder holding a flavor's installer and backups. It need not exist yet. */
export function mediaDir(flavor: FlavorKey, options: MediaOptions = {}): string {
  return join(resolveMediaRoot(options), basename(getFlavor(flavor).mediaFolder));
}

/** The files a flavor's media folder is expected to hold (ticket 02's list): the MSI and both backups. */
export function expectedMediaFiles(flavor: FlavorKey): string[] {
  const f = getFlavor(flavor);
  return [f.msiName, f.backups.core, f.backups.coreAndSolutions];
}

/** The path of `fileName` in a flavor's media folder; it is not checked for existence. */
export function mediaFile(flavor: FlavorKey, fileName: string, options: MediaOptions = {}): string {
  if (fileName === "" || fileName === "." || fileName === ".." || /[\\/]/.test(fileName)) {
    throw new MediaError(`"${fileName}" is not a plain media file name`);
  }
  return join(mediaDir(flavor, options), fileName);
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The expected files (see `expectedMediaFiles`) that are not in the flavor's media folder. */
export function missingMedia(flavor: FlavorKey, options: MediaOptions = {}): string[] {
  return expectedMediaFiles(flavor).filter((name) => !isFile(mediaFile(flavor, name, options)));
}

/** The path of an existing media file, or a `MediaError` naming the exact path and what is expected. */
export function requireMediaFile(flavor: FlavorKey, fileName: string, options: MediaOptions = {}): string {
  const path = mediaFile(flavor, fileName, options);
  if (isFile(path)) return path;
  const dir = dirname(path);
  throw new MediaError(
    `missing media file: ${path}\n` +
      `${existsSync(dir) ? "The folder exists but" : "The folder does not exist, and"} flavor ${flavor} needs ` +
      `${expectedMediaFiles(flavor).join(", ")} in it (the installer handoff list, ticket 02).\n` +
      `Put the files in the main checkout's media/${basename(dir)}/ (see media/README.md), or set ${MEDIA_ENV}.`,
  );
}
