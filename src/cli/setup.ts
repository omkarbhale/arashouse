// `arashouse setup`: writes `setup-host.ps1` (src/core/setup-host.ts) and the broker build it installs to
// a folder on the Windows side, and says how to run it; the captain runs it once, elevated (ticket 21).
// Also what `arashouse doctor` reads back from WSL: the script's record, and which folders under the
// root the worker can list. See docs/setup.md.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FLAVOR_KEYS, type FlavorKey } from "../core/flavors.js";
import { UsageError } from "../core/lease.js";
import { DEFAULT_INSTALL_ROOT, setupRecordFile } from "../core/names.js";
import {
  ROOT_FOLDERS,
  renderSetupHostScript,
  type AppFile,
  type RootFolder,
  type SetupObservation,
  type WorkerIdentity,
} from "../core/setup-host.js";

const execFileAsync = promisify(execFile);

/** Runs a program and returns its stdout; replaced in tests. */
export type Run = (file: string, args: string[]) => Promise<string>;

export const defaultRun: Run = async (file, args) =>
  (
    await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      // cmd.exe and whoami.exe complain when they start in a \\wsl.localhost folder.
      cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined,
    })
  ).stdout;

/** The script's file name in the bundle. */
export const SETUP_SCRIPT_NAME = "setup-host.ps1";

/** The built `dist\` this CLI runs from (the folder holding `cli\` and `broker\`). */
export const DIST_DIR = fileURLToPath(new URL("../", import.meta.url));

/** The repo's `package.json`, which the broker reads its version and module type from. */
export const PACKAGE_JSON = fileURLToPath(new URL("../../package.json", import.meta.url));

/**
 * The Windows user WSL interop runs as (`whoami.exe /user`): the worker user the ACLs name. It is the
 * user who runs `arashouse setup`, which is why the command runs from a worker's shell.
 */
export async function workerIdentity(run: Run = defaultRun): Promise<WorkerIdentity> {
  let text: string;
  try {
    text = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  } catch (err) {
    throw new Error(`cannot ask Windows who the worker user is (whoami.exe through WSL interop): ${err instanceof Error ? err.message : String(err)}`);
  }
  const m = /^"([^"]+)","(S-1-5-21-[0-9-]+)"\s*$/m.exec(text.replace(/\r/g, ""));
  if (!m) throw new Error("whoami.exe /user did not print a user and an account SID");
  return { name: m[1] as string, sid: m[2] as string };
}

/** Every file under `dir`, relative with backslashes, with its SHA-256, in a stable order. */
export async function collectAppFiles(dir: string): Promise<AppFile[]> {
  const out: AppFile[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push({ path: relative(dir, full).split(sep).join("\\"), sha256: sha256(await readFile(full)) });
      else throw new Error(`${full} is not a plain file or folder`);
    }
  };
  await walk(dir);
  return out;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface BundleOptions {
  /** Where to write the bundle (a WSL path to a folder on a Windows drive). */
  readonly outDir: string;
  /** The built `dist\` to install as the broker. */
  readonly distDir: string;
  readonly packageJson: string;
  readonly version: string;
  readonly worker: WorkerIdentity;
  readonly flavors: readonly FlavorKey[];
  readonly root?: string;
}

export interface Bundle {
  readonly script: string;
  readonly files: number;
}

/** The names a bundle folder holds; anything else in it means it is not ours, and it is left alone. */
const BUNDLE_ENTRIES = new Set([SETUP_SCRIPT_NAME, "package.json", "app"]);

/**
 * Writes `setup-host.ps1`, `package.json` and `app\` (a copy of `distDir`) to `outDir`, replacing an
 * earlier bundle there. Refuses a folder that holds anything else, and a `distDir` that is not a build.
 */
export async function writeSetupBundle(options: BundleOptions): Promise<Bundle> {
  if (!existsSync(join(options.distDir, "broker", "index.js")) || !existsSync(join(options.distDir, "broker", "client.js"))) {
    throw new UsageError("arashouse setup installs the built broker: run it from the build (`npm run build`, then `node dist/cli/index.js setup`)");
  }
  if (existsSync(options.outDir)) {
    const foreign = (await readdir(options.outDir)).filter((name) => !BUNDLE_ENTRIES.has(name));
    if (foreign.length > 0) throw new UsageError(`${options.outDir} holds ${foreign.slice(0, 3).join(", ")}, which a setup bundle does not; choose an empty folder with --out`);
  }
  const appFiles = await collectAppFiles(options.distDir);
  const packageJson = await readFile(options.packageJson);
  const script = renderSetupHostScript({
    root: options.root,
    version: options.version,
    worker: options.worker,
    flavors: options.flavors,
    appFiles,
    packageJsonSha256: sha256(packageJson),
  });
  if (!/^[\x00-\x7f]*$/.test(script)) throw new Error("the generated script is not plain ASCII, which Windows PowerShell 5.1 would misread");

  await rm(join(options.outDir, "app"), { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });
  for (const file of appFiles) {
    const target = join(options.outDir, "app", ...file.path.split("\\"));
    await mkdir(join(target, ".."), { recursive: true });
    await copyFile(join(options.distDir, ...file.path.split("\\")), target);
  }
  await writeFile(join(options.outDir, "package.json"), packageJson);
  const scriptPath = join(options.outDir, SETUP_SCRIPT_NAME);
  await writeFile(scriptPath, script.replace(/\r?\n/g, "\r\n"), "ascii");
  return { script: scriptPath, files: appFiles.length };
}

/** The WSL path of a Windows drive path under the default automount (`C:\x` is `/mnt/c/x`). */
export function wslPathOf(windowsPath: string): string {
  const m = /^([A-Za-z]):\\(.*)$/.exec(windowsPath);
  if (!m) throw new Error(`"${windowsPath}" is not a Windows drive path`);
  const rest = (m[2] ?? "").split("\\").filter(Boolean).join("/");
  return `/mnt/${(m[1] as string).toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** The flavors whose prerequisites the script checks: those with media in `media/`, or every flavor when none can be told. */
export async function flavorsToCheck(present: (flavor: FlavorKey) => Promise<boolean | null>): Promise<FlavorKey[]> {
  const found: FlavorKey[] = [];
  for (const flavor of FLAVOR_KEYS) if ((await present(flavor).catch(() => null)) === true) found.push(flavor);
  return found.length > 0 ? found : [...FLAVOR_KEYS];
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

export interface ObserveOptions {
  /** The install root, as a Windows path. */
  readonly root?: string;
  /** Turns a Windows path into one this process can open; `wslPathOf` unless a test maps it elsewhere. */
  readonly toLocal?: (windowsPath: string) => string;
}

/** What `arashouse doctor` sees of the setup from WSL: the record, and whether the worker can list each folder. */
export async function observeSetup(options: ObserveOptions = {}): Promise<SetupObservation> {
  const root = options.root ?? DEFAULT_INSTALL_ROOT;
  const toLocal = options.toLocal ?? wslPathOf;
  const rootExists = existsSync(toLocal(root));
  const access: Partial<Record<RootFolder, "read" | "denied" | "missing">> = {};
  for (const folder of ROOT_FOLDERS) {
    try {
      await readdir(toLocal(win32.join(root, folder)));
      access[folder] = "read";
    } catch (err) {
      const code = errorCode(err);
      access[folder] = code === "EACCES" || code === "EPERM" ? "denied" : "missing";
    }
  }
  let record: unknown = null;
  try {
    record = JSON.parse(await readFile(toLocal(setupRecordFile(root)), "utf8"));
  } catch (err) {
    if (errorCode(err) !== "ENOENT") record = new Error(err instanceof Error ? err.message : String(err));
  }
  return { record, rootExists, access };
}
