// Where this process runs, and how it opens the host's paths. arashouse runs natively on Windows: the CLI, its state
// and every pool process are Windows processes, and a Windows path is already a local path. From WSL, `arashouse` is a
// launcher (src/launcher/) that runs the Windows build through interop; the WSL branches here serve it, the WSL-side
// tests, and the tools that still read the host's files from WSL (`/mnt/c/...` under the default automount). This is
// the one module that knows about `/mnt/<drive>`, `wslpath` and `\\wsl.localhost\`.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `windows`: native Windows. `wsl`: Linux inside WSL, with the Windows drives under `/mnt`. `linux`: anything else. */
export type Side = "windows" | "wsl" | "linux";

/** Which side `platform` and the kernel `osRelease` are (WSL's kernel names Microsoft). */
export function detectSide(platform: NodeJS.Platform = process.platform, osRelease: string = release()): Side {
  if (platform === "win32") return "windows";
  return /microsoft/i.test(osRelease) ? "wsl" : "linux";
}

/** This process's side, found once. */
export const SIDE: Side = detectSide();

/**
 * Set by the WSL launcher on the Windows process it starts: the WSL distribution the caller runs in. A POSIX path the
 * caller gave is then read through `\\wsl.localhost\<distro>\`, and `/mnt/<d>/...` is the drive path itself.
 */
export const WSL_DISTRO_ENV = "ARASHOUSE_WSL_DISTRO";

/** The distribution name the launcher may pass: what `WSL_DISTRO_NAME` holds (no separators, no `..`). */
const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

/** A Windows drive path, with either separator: `C:\x` or `C:/x`. */
const DRIVE_PATH = /^([A-Za-z]):[\\/]/;

export function isDrivePath(text: string): boolean {
  return DRIVE_PATH.test(text);
}

/** The WSL path of a Windows drive path under the default automount (`C:\x` is `/mnt/c/x`). */
export function wslPathOf(windowsPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!m) throw new Error(`"${windowsPath}" is not a Windows drive path`);
  const rest = (m[2] ?? "").split(/[\\/]/).filter(Boolean).join("/");
  return `/mnt/${(m[1] as string).toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** The drive path of a `/mnt/<d>/...` path (`/mnt/c/x` is `C:\x`), or undefined for any other path. */
export function drivePathOfMount(path: string): string | undefined {
  const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(path);
  if (!m) return undefined;
  const rest = (m[2] ?? "").split("/").filter(Boolean).join("\\");
  return `${(m[1] as string).toUpperCase()}:\\${rest}`;
}

/** The `\\wsl.localhost\<distro>\...` path of an absolute path inside a WSL distribution. */
export function uncPathOf(posixPath: string, distro: string): string {
  if (!DISTRO_NAME.test(distro)) throw new Error(`"${distro}" is not a WSL distribution name`);
  if (!posixPath.startsWith("/")) throw new Error(`"${posixPath}" is not an absolute path`);
  const rest = posix.normalize(posixPath).split("/").filter(Boolean).join("\\");
  return `\\\\wsl.localhost\\${distro}${rest ? `\\${rest}` : ""}`;
}

/** The path this process opens for a Windows drive path (one under the install root, say). */
export function toLocal(windowsPath: string, side: Side = SIDE): string {
  if (!isDrivePath(windowsPath)) throw new Error(`"${windowsPath}" is not a Windows drive path`);
  return side === "windows" ? win32.normalize(windowsPath) : wslPathOf(windowsPath);
}

/** The WSL distribution the launcher said the caller runs in, or undefined (a native caller, or not on Windows). */
export function callerDistro(env: NodeJS.ProcessEnv, side: Side = SIDE): string | undefined {
  if (side !== "windows") return undefined;
  const distro = env[WSL_DISTRO_ENV]?.trim();
  return distro && DISTRO_NAME.test(distro) ? distro : undefined;
}

export interface CallerPathOptions {
  /** What a relative path is relative to; defaults to the working folder. */
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly side?: Side;
}

/**
 * The local path of a path the caller gave (`--code`, `--restore`, `--to`, a recipe, a manifest): a Windows drive path
 * is the drive path (through its mount from WSL); on Windows, when the WSL launcher started this process, `/mnt/<d>/x`
 * is `<D>:\x` and any other absolute POSIX path is read through `\\wsl.localhost\<distro>\`; anything else is
 * relative to `cwd`.
 */
export function callerPath(text: string, options: CallerPathOptions = {}): string {
  const side = options.side ?? SIDE;
  const cwd = options.cwd ?? process.cwd();
  if (isDrivePath(text)) return toLocal(text.replace(/\//g, "\\"), side);
  if (side !== "windows") return posix.resolve(cwd, text);
  const distro = callerDistro(options.env ?? process.env, side);
  if (distro !== undefined && text.startsWith("/")) return drivePathOfMount(text) ?? uncPathOf(text, distro);
  return win32.resolve(cwd, text);
}

/** Runs a program and returns its stdout; replaced in tests. */
export type Run = (file: string, args: string[]) => Promise<string>;

/** The folder Windows tools start in: none natively; from WSL a `C:` one, since `cmd.exe` complains in `\\wsl.localhost\`. */
export function runCwd(side: Side = SIDE): string | undefined {
  if (side === "windows") return undefined;
  return existsSync("/mnt/c") ? "/mnt/c" : undefined;
}

export const defaultRun: Run = async (file, args) =>
  (await execFileAsync(file, args, { encoding: "utf8", timeout: 30_000, windowsHide: true, cwd: runCwd() })).stdout;

/**
 * The Windows temp folder, as this process opens it: `os.tmpdir()` natively; from WSL, `%TEMP%` (through `cmd.exe`)
 * under its `/mnt` mount, where Windows tools and the broker can read what is put there.
 */
export async function tempDir(side: Side = SIDE, run: Run = defaultRun): Promise<string> {
  if (side === "windows") return tmpdir();
  const windowsTemp = (await run("cmd.exe", ["/c", "echo %TEMP%"])).trim();
  if (!isDrivePath(windowsTemp)) throw new Error("cannot find the Windows temp folder through cmd.exe");
  return wslPathOf(windowsTemp);
}

/**
 * The Windows path of a local path, to print or to hand a Windows tool: the path itself natively; from WSL, what
 * `wslpath -w` says (`C:\...` for a `/mnt/c` path, else a `\\wsl.localhost\` path).
 */
export async function windowsPathOf(localPath: string, side: Side = SIDE, run: Run = defaultRun): Promise<string> {
  if (side === "windows") return win32.resolve(localPath);
  return (await run("wslpath", ["-w", localPath])).trim();
}
