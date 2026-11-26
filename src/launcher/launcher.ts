// `arashouse` typed in WSL: a launcher for the Windows build. arashouse runs on Windows (the pool's state on NTFS, the
// broker's pipe in the same process, every pool process a Windows one), so from WSL this runs the same build on the
// Windows `node.exe` through interop (src/launcher/windows-entry.ts copies it to Windows first) and passes its output
// and exit code through. The Windows side reads the caller's paths through `\\wsl.localhost\<distro>\` or `/mnt/<d>`
// (`ARASHOUSE_WSL_DISTRO`, src/host/platform.ts), and builds slot URLs with the address WSL reaches the host at, so
// `get --json` reads as it did from WSL. Three things stay on this side:
//
// - `run` executes its command here, in WSL, with the environment `env --lease <id> --json` gives (the password
//   crosses on that command's stdout, as it does for `get --json`, never in an argument or a file);
// - `get --password-fd <n>` writes the password to this process's descriptor <n>;
// - a start of `node.exe` that WSL's interop could not set up (`UtilAcceptVsock`, tickets 38 and 56) is tried again: the
//   Windows process never ran;
// - `migrate-state`, which moves the pool's state from WSL's `~/.arashouse` to Windows (src/launcher/migrate.ts).
//
// `ARASHOUSE_HOST=fake` (the tests' host) runs the CLI here instead, with its own state; so does a WSL with no Windows
// Node, where nothing on Windows could be reached anyway (the CLI then says the host is unreachable, as it always has).
//
// Each launch costs a Node start here and a `node.exe` start through interop. Once this build's runtime copy exists,
// `node.exe` is started on it by its Windows path; the `\wsl.localhost` entry is only for the first launch of a build.
// The modules `run` and `--password-fd` need are loaded when those run.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { setTimeout as sleepMs } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../core/exit-codes.js";
import { Secret } from "../core/secret.js";
import { SIDE, WINDOWS_NODE_ENV, WSL_DISTRO_ENV, drivePathOfMount, isDrivePath, runCwd, uncPathOf, wslPathOf, type Side } from "../host/platform.js";
import { LAUNCHER_ENV, launcherApplies as applies, windowsNode } from "./applies.js";
import { RUNTIME_MARKER } from "./windows-entry.js";

export { LAUNCHER_ENV, windowsNode };

/** `ARASHOUSE_HOST_ADDR` (src/host/url.ts): the host address slot URLs are built with. */
const HOST_ADDR_ENV = "ARASHOUSE_HOST_ADDR";

/** The gateway in `ip route` output (`default via 172.19.0.1 dev eth0 ...`), or undefined; as src/host/url.ts reads it. */
function parseDefaultGateway(routeOutput: string): string | undefined {
  const gateway = /^default\s+via\s+(\S+)/m.exec(routeOutput)?.[1];
  return gateway !== undefined && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway) ? gateway : undefined;
}

/** The build this launcher belongs to: the folder holding `dist/` and `package.json`. */
export const BUILD_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The variables passed on to the Windows process, their values as Windows reads them (`WSLENV` carries them). */
// LOCALAPPDATA is not set in WSL; when it is, it was set on purpose (the launcher's tests keep the runtime folder there).
const PATH_VARS = ["ARASHOUSE_MEDIA", "ARASHOUSE_APKG", "ARASHOUSE_HOME", "ARASHOUSE_WINDOWS_GIT", "ARASHOUSE_LOCAL_ROOT", "ARASHOUSE_BROKER_TOKEN_FILE", "LOCALAPPDATA"] as const;

/** `ARASHOUSE_CHECKOUT_MEDIA` (src/core/media.ts): the media of the checkout this launcher runs from. */
const CHECKOUT_MEDIA_ENV = "ARASHOUSE_CHECKOUT_MEDIA";

/**
 * The `media/` of the arashouse checkout this launcher runs from (its main checkout's, as the CLI in WSL always found
 * it), or undefined: not in a checkout, git missing, or not arashouse's. It is the Windows side's last resort, after
 * `ARASHOUSE_MEDIA` and config.json's `media`.
 */
export function checkoutMedia(root: string = BUILD_ROOT): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!common.endsWith("/.git")) return undefined;
    const checkout = dirname(common);
    const pkg = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === "arashouse" && existsSync(join(checkout, "media")) ? join(checkout, "media") : undefined;
  } catch {
    return undefined;
  }
}
const PLAIN_VARS = ["ARASHOUSE_HOST", "ARASHOUSE_DEBUG", "ARASHOUSE_RESET_WORKER", "ARAS_PKG_ENGINE", "ARASHOUSE_FAKE_FAULTS", "ARASHOUSE_FAKE_PROBE"] as const;

/** WSL's own line when it cannot connect a Windows process's channels; the process never ran. */
const INTEROP_START_FAILURE = /^<\d+>WSL \(\d+[^)]*\) ERROR: Util\w*Vsock\w*:.*$/m;
export const LAUNCH_ATTEMPTS = 3;
const LAUNCH_RETRY_MS = 1_000;

/** Where the pool's state lived before arashouse ran on Windows: WSL's `~/.arashouse/state.json`. */
export function wslStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME?.trim() || homedir(), ".arashouse", "state.json");
}

/**
 * Refuses to launch while the pool's state is still WSL's (`~/.arashouse/state.json`, not moved to Windows): the Windows
 * build would see an empty pool, every slot on the host an orphan, and the leases held in WSL's state not held at all.
 * An `ARASHOUSE_HOME` set on purpose is that state, and is used.
 */
export function assertStateMoved(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): void {
  if (env.ARASHOUSE_HOME?.trim()) return;
  const legacy = wslStateFile(env);
  if (!exists(legacy)) return;
  throw new LaunchError(
    1,
    `the pool's state is still WSL's (${legacy}), and arashouse now keeps it on Windows (%LOCALAPPDATA%\\arashouse): ` +
      "move it there first (docs/windows-native.md, \"Migrating a pool from WSL's state to Windows\"); nothing was done",
  );
}

/** Whether `arashouse` in this process is the launcher (src/launcher/applies.ts). */
export function launcherApplies(env: NodeJS.ProcessEnv, side: Side = SIDE, exists: (path: string) => boolean = existsSync): boolean {
  return applies(env, side, exists);
}

/** Where this side keeps the Windows `%LOCALAPPDATA%` it asked for once (`cmd.exe` takes a moment to start). */
export function localAppDataCache(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "arashouse", "localappdata");
}

/**
 * The Windows `%LOCALAPPDATA%`, as a Windows path: `LOCALAPPDATA` when set here (tests), else the one this side asked
 * Windows for and kept, else asked now (and kept). Undefined when it cannot be found: the launch then goes through the
 * `\\wsl.localhost` entry, which finds it on the Windows side.
 */
export function windowsLocalAppData(env: NodeJS.ProcessEnv, distro: string, ask: () => string | undefined = askLocalAppData, cwd?: string): string | undefined {
  const given = env.LOCALAPPDATA?.trim();
  if (given) return windowsPathFor(given, distro, cwd);
  const cache = localAppDataCache(env);
  try {
    const kept = readFileSync(cache, "utf8").trim();
    if (isDrivePath(kept) && existsSync(wslPathOf(kept))) return kept;
  } catch {
    // Not kept yet.
  }
  const asked = ask();
  if (asked === undefined || !isDrivePath(asked)) return undefined;
  try {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, `${asked}\n`);
  } catch {
    // Kept next time, then.
  }
  return asked;
}

function askLocalAppData(): string | undefined {
  try {
    return execFileSync("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], { encoding: "utf8", timeout: 10_000, cwd: runCwd(), stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

class LaunchError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The id of this build's runtime folder on Windows: a hash of its files (no source maps) and package.json. */
export function runtimeId(root: string = BUILD_ROOT): string {
  const hash = createHash("sha256");
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !entry.name.endsWith(".map")) hash.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");
    }
  };
  walk("dist");
  hash.update("package.json\0").update(readFileSync(join(root, "package.json")));
  return hash.digest("hex").slice(0, 16);
}

/** A WSL path as the Windows process opens it: `/mnt/<d>/x` is `<D>:\x`, any other is `\\wsl.localhost\<distro>\x`. */
export function windowsPathFor(path: string, distro: string, cwd: string = process.cwd()): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  return drivePathOfMount(absolute) ?? uncPathOf(absolute, distro);
}

/**
 * The libs-js CLI on this side's PATH (an npm link to its `dist/cli.js`), as a script the Windows Node can run, or
 * undefined. The Windows folders WSL appends to PATH (`/mnt/<d>/...`) are skipped: they hold no such link, and looking
 * in each through drvfs would cost every launch.
 */
export function findApkgScript(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "" || dir.startsWith("/mnt/")) continue;
    const path = join(dir, "aras-pkg");
    if (!existsSync(path)) continue;
    try {
      const target = realpathSync(path);
      return /\.[cm]?js$/.test(target) ? target : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface Networking {
  /** `wslinfo --networking-mode`: `nat`, `mirrored`, or undefined when it cannot tell. */
  readonly mode: () => string | undefined;
  /** The default gateway (`ip route`), or undefined. */
  readonly gateway: () => string | undefined;
}

const liveNetworking: Networking = {
  mode: () => {
    try {
      return execFileSync("wslinfo", ["--networking-mode"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  },
  gateway: () => {
    try {
      return parseDefaultGateway(execFileSync("ip", ["route", "show", "default"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return undefined;
    }
  },
};

/**
 * The address the slot URLs are built with, so they work from WSL and from Windows alike: the caller's
 * `ARASHOUSE_HOST_ADDR`; in NAT mode the default gateway (the host, which Windows reaches at that address too); in
 * mirrored mode none (`localhost` serves both).
 */
export function hostAddressFor(env: NodeJS.ProcessEnv, net: Networking = liveNetworking): string | undefined {
  const given = env[HOST_ADDR_ENV]?.trim();
  if (given) return given;
  if (net.mode() === "mirrored") return undefined;
  return net.gateway();
}

/** The variables the Windows process gets, and the `WSLENV` that carries them across. */
export function windowsEnvironment(
  env: NodeJS.ProcessEnv,
  distro: string,
  options: { readonly cwd?: string; readonly net?: Networking; readonly checkoutMedia?: () => string | undefined } = {},
): NodeJS.ProcessEnv {
  const out: Record<string, string> = { [WSL_DISTRO_ENV]: distro };
  for (const name of PLAIN_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  const apkg = env.ARASHOUSE_APKG?.trim() || findApkgScript(env);
  for (const name of PATH_VARS) {
    const value = name === "ARASHOUSE_APKG" ? apkg : env[name]?.trim();
    if (value === undefined || value === "") continue;
    const windows = windowsPathFor(value, distro, options.cwd);
    if (name === "ARASHOUSE_HOME" && !/^[A-Za-z]:\\/.test(windows)) {
      throw new LaunchError(
        EXIT_CODES.usage,
        `ARASHOUSE_HOME is ${value}, on WSL's disk: the pool's state lives on Windows (%LOCALAPPDATA%\\arashouse by default); unset it, or name a folder under /mnt/<drive>`,
      );
    }
    out[name] = windows;
  }
  if (!env.ARASHOUSE_MEDIA?.trim()) {
    const media = (options.checkoutMedia ?? checkoutMedia)();
    if (media !== undefined) out[CHECKOUT_MEDIA_ENV] = windowsPathFor(media, distro);
  }
  const address = hostAddressFor(env, options.net);
  if (address !== undefined) out[HOST_ADDR_ENV] = address;
  const carried = [env.WSLENV, ...Object.keys(out)].filter((v): v is string => v !== undefined && v !== "").join(":");
  return { ...out, WSLENV: carried };
}

export interface LaunchIo {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
}

/** How a Windows process is started; replaced in tests. */
export type Spawner = (node: string, args: readonly string[], env: NodeJS.ProcessEnv) => import("node:child_process").ChildProcess;

const liveSpawner: Spawner = (node, args, env) => spawn(node, args, { env, stdio: ["inherit", "pipe", "pipe"] });

export interface LauncherDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly io: LaunchIo;
  readonly spawn?: Spawner;
  readonly net?: Networking;
  readonly cwd?: string;
  /** The build to run (the folder holding `dist/`); defaults to this one. */
  readonly root?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The Windows `%LOCALAPPDATA%` (`windowsLocalAppData`); replaced in tests. */
  readonly localAppData?: (env: NodeJS.ProcessEnv, distro: string) => string | undefined;
  /** Whether a path exists on this side (the runtime copy's marker); replaced in tests. */
  readonly exists?: (path: string) => boolean;
  /** How `--password-fd` is checked and written on this side; replaced in tests. */
  readonly passwordFd?: { readonly parse: (text: string) => number; readonly write: (fd: number, password: Secret) => void };
}

interface Launch {
  readonly code: number;
  readonly stdout: string;
}

/** Runs the Windows build once per attempt, passing output on as it comes (or keeping stdout, `capture`). */
async function runWindows(deps: LauncherDeps, args: readonly string[], capture: boolean): Promise<Launch> {
  const env = deps.env;
  const node = windowsNode(env);
  if (deps.spawn === undefined && !existsSync(node)) {
    throw new LaunchError(1, `arashouse runs on Windows, and there is no Windows Node at ${node}: install Node 20 or newer on Windows, or set ${WINDOWS_NODE_ENV} to its node.exe`);
  }
  const distro = env.WSL_DISTRO_NAME?.trim();
  if (!distro) throw new LaunchError(1, "WSL_DISTRO_NAME is not set, so the Windows side cannot read this distribution's paths");
  const root = deps.root ?? BUILD_ROOT;
  const childEnv = { ...env, ...windowsEnvironment(env, distro, { cwd: deps.cwd, net: deps.net }) };
  const id = runtimeId(root);
  // This build's runtime copy, when it exists, by its Windows path; else the entry, which makes it.
  const localAppData = (deps.localAppData ?? ((e: NodeJS.ProcessEnv, d: string) => windowsLocalAppData(e, d, undefined, deps.cwd)))(env, distro);
  const runtime = localAppData === undefined ? undefined : win32.join(localAppData, "arashouse", "runtime", id);
  const ready = runtime !== undefined && (deps.exists ?? existsSync)(wslPathOf(win32.join(runtime, RUNTIME_MARKER)));
  const launchArgs = ready ? [win32.join(runtime, "dist", "cli", "index.js")] : [windowsPathFor(join(root, "dist", "launcher", "windows-entry.js"), distro), id];
  const start = deps.spawn ?? liveSpawner;
  const sleep = deps.sleep ?? ((ms: number) => sleepMs(ms).then(() => undefined));
  for (let attempt = 1; ; attempt++) {
    const outcome = await new Promise<Launch & { stderr: string }>((resolveRun) => {
      const child = start(node, [...launchArgs, ...args], childEnv);
      let stdout = "";
      let stderr = "";
      let pending = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (!capture) deps.io.stdout(chunk);
      });
      // Line by line, so WSL's own start failure can be kept back while it may still be retried.
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        const lines = (pending + chunk).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (!INTEROP_START_FAILURE.test(line)) deps.io.stderr(`${line}\n`);
      });
      const forward = (signal: NodeJS.Signals) => () => void child.kill(signal);
      const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [signal, forward(signal)] as const);
      for (const [signal, handler] of handlers) process.on(signal, handler);
      const done = (code: number) => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
        if (pending !== "" && !INTEROP_START_FAILURE.test(pending)) deps.io.stderr(pending);
        resolveRun({ code, stdout, stderr });
      };
      child.on("error", (err: NodeJS.ErrnoException) => {
        stderr += `arashouse: cannot start ${node} (${err.code ?? err.message})`;
        done(EXIT_CODES.hostUnreachable);
      });
      child.on("close", (code, signal) => done(code ?? (signal ? 128 : 1)));
    });
    const neverRan = outcome.stdout === "" && INTEROP_START_FAILURE.test(outcome.stderr) && !/^arashouse/m.test(outcome.stderr);
    if (!neverRan) return outcome;
    if (attempt >= LAUNCH_ATTEMPTS) {
      deps.io.stderr(`arashouse: WSL could not start ${node} (${INTEROP_START_FAILURE.exec(outcome.stderr)?.[0] ?? "interop"}); try again\n`);
      return { code: EXIT_CODES.hostUnreachable, stdout: "" };
    }
    await sleep(LAUNCH_RETRY_MS * attempt);
  }
}

/** Splits the global flags off the command, as the CLI does: `[command, its args, global flags]`. */
function commandOf(argv: readonly string[]): { command: string | undefined; args: string[]; globals: string[]; help: boolean } {
  const at = argv.indexOf("--");
  const head = at === -1 ? [...argv] : argv.slice(0, at);
  const rest = at === -1 ? [] : argv.slice(at);
  const globals = head.filter((a) => a === "--verbose");
  const help = head.includes("--help") || head.includes("-h");
  const words = head.filter((a) => a !== "--verbose");
  const [command, ...args] = words;
  return { command, args: [...args, ...rest], globals, help };
}

/** `run`, here: the lease's environment from the Windows side, the command in WSL. */
async function runHere(deps: LauncherDeps, args: readonly string[], globals: readonly string[]): Promise<number> {
  const [{ parseArgs }, { runChild }] = await Promise.all([import("../cli/args.js"), import("../cli/run.js")]);
  const parsed = parseArgs(args, { lease: "value" });
  const lease = typeof parsed.options.lease === "string" ? parsed.options.lease : undefined;
  if (parsed.positionals.length > 0 || parsed.rest === undefined || lease === undefined) {
    // The Windows side says what is wrong, with the same words and exit code as ever.
    return (await runWindows(deps, ["run", ...args], false)).code;
  }
  const got = await runWindows(deps, [...globals, "env", "--lease", lease, "--json"], true);
  if (got.code !== 0) return got.code;
  let leaseEnv: Record<string, string>;
  try {
    leaseEnv = JSON.parse(got.stdout) as Record<string, string>;
  } catch {
    throw new LaunchError(1, "the Windows side's `env --json` printed something that is not JSON");
  }
  const [program, ...rest] = parsed.rest;
  if (program === undefined || program === "") throw new LaunchError(EXIT_CODES.usage, "run needs a command after --");
  return runChild(program, rest, { env: { ...deps.env, ...leaseEnv }, err: (line) => deps.io.stderr(`${line}\n`) });
}

/** `get ... --password-fd <n>`, here: the Windows side's `--json`, and the password written to this process's <n>. */
/** Where `--password-fd` is in `args` (`--password-fd <n>` or `--password-fd=<n>`), its value, and how many words it takes. */
function passwordFdOption(args: readonly string[]): { at: number; value: string | undefined; words: number } | undefined {
  const at = args.findIndex((a) => a === "--password-fd" || a.startsWith("--password-fd="));
  if (at === -1) return undefined;
  const arg = args[at] as string;
  return arg === "--password-fd" ? { at, value: args[at + 1], words: 2 } : { at, value: arg.slice("--password-fd=".length), words: 1 };
}

async function getWithFd(deps: LauncherDeps, command: string, args: readonly string[], globals: readonly string[]): Promise<number> {
  const option = passwordFdOption(args);
  const fdText = option?.value;
  if (option === undefined || fdText === undefined) return (await runWindows(deps, [...globals, command, ...args], false)).code;
  const at = option.at;
  const { parsePasswordFd, writePasswordFd } = await import("../cli/password-fd.js");
  const fdIo = deps.passwordFd ?? { parse: (text: string) => parsePasswordFd(text, "linux"), write: writePasswordFd };
  const fd = fdIo.parse(fdText);
  const json = args.includes("--json");
  const windowsArgs = [...args.slice(0, at), ...args.slice(at + option.words)];
  if (!json) windowsArgs.push("--json");
  const got = await runWindows(deps, [...globals, command, ...windowsArgs], true);
  let grant: Record<string, unknown>;
  try {
    grant = JSON.parse(got.stdout) as Record<string, unknown>;
  } catch {
    deps.io.stdout(got.stdout);
    return got.code;
  }
  const { password, ...shown } = grant;
  if (typeof password === "string") {
    try {
      fdIo.write(fd, Secret.of(password, "lease-password"));
    } catch {
      // Nobody has the password, so nobody can use the lease: it goes back at once, as the CLI does.
      if (typeof grant.lease_id === "string") await runWindows(deps, ["return", grant.lease_id, "--quiet"], true);
      throw new LaunchError(EXIT_CODES.usage, `the password could not be written to descriptor ${fd}; the lease of ${String(grant.slot)} was returned`);
    }
  }
  if (json) deps.io.stdout(`${JSON.stringify(shown, null, 2)}\n`);
  else {
    const lines = [
      `leased ${String(grant.slot)} (engine ${String(grant.engine)}) to ${String(grant.holder)}`,
      `url:       ${String(grant.url)}`,
      `database:  ${String(grant.database)}`,
      `user:      ${String(grant.user)}`,
      `lease id:  ${String(grant.lease_id)}`,
      `password:  written to descriptor ${fd}`,
    ];
    if (grant.bootstrap !== undefined || grant.imports !== undefined) lines.push("details:   run with --json to see the steps");
    lines.push(`return it with: arashouse return ${String(grant.lease_id)}`);
    for (const line of lines) deps.io.stdout(`${line}\n`);
  }
  return got.code;
}

export const MIGRATE_HELP = [
  "usage: arashouse migrate-state [--yes [--busy-ok]]   (in WSL)",
  "",
  "Moves the pool's state from WSL's ~/.arashouse to Windows (%LOCALAPPDATA%\\arashouse, or ARASHOUSE_HOME under /mnt/<drive>):",
  "config.json, events.log, recipes/, logs/, leases/ (the held leases' passwords), then state.json, under the old state's lock;",
  "then WSL's state.json and leases/ are renamed aside (*.moved-to-windows-<time>), never deleted. A dry run without --yes.",
  "It refuses a Windows home that already holds a state, and a pool with a reset running or a get --wait queued unless",
  "--busy-ok. Run it once every WSL caller's arashouse is this build (docs/windows-native.md, \"Migrating\").",
];

/** `migrate-state`, here in WSL: from `~/.arashouse` to the Windows home. */
async function migrateHere(deps: LauncherDeps, args: readonly string[], help: boolean): Promise<number> {
  if (help) {
    for (const line of MIGRATE_HELP) deps.io.stdout(`${line}\n`);
    return 0;
  }
  const unknown = args.filter((a) => a !== "--yes" && a !== "--busy-ok");
  if (unknown.length > 0) throw new LaunchError(EXIT_CODES.usage, `migrate-state takes --yes and --busy-ok, not "${unknown[0]}"`);
  const env = deps.env;
  const distro = env.WSL_DISTRO_NAME?.trim();
  if (!distro) throw new LaunchError(1, "WSL_DISTRO_NAME is not set, so this is not WSL");
  const given = env.ARASHOUSE_HOME?.trim();
  let to: string;
  if (given) {
    if (!/^\/mnt\/[a-z]\//.test(given)) throw new LaunchError(EXIT_CODES.usage, `ARASHOUSE_HOME is ${given}: the state moves to a Windows drive (/mnt/<drive>/...)`);
    to = given;
  } else {
    const local = (deps.localAppData ?? ((e: NodeJS.ProcessEnv, d: string) => windowsLocalAppData(e, d, undefined, deps.cwd)))(env, distro);
    if (local === undefined) throw new LaunchError(1, "cannot find the Windows %LOCALAPPDATA% (cmd.exe did not answer); set ARASHOUSE_HOME to the Windows home under /mnt/<drive>");
    to = wslPathOf(win32.join(local, "arashouse"));
  }
  const { migrateState } = await import("./migrate.js");
  const result = await migrateState({
    from: join(env.HOME?.trim() || homedir(), ".arashouse"),
    to,
    toShown: drivePathOfMount(to) ?? to,
    yes: args.includes("--yes"),
    busyOk: args.includes("--busy-ok"),
  });
  for (const line of result.lines) deps.io.stdout(`${line}\n`);
  return result.code;
}

/** Runs one `arashouse` invocation from WSL on the Windows build, and resolves with its exit code. It never throws. */
export async function runLauncher(argv: readonly string[], deps: LauncherDeps): Promise<number> {
  try {
    const { command, args, globals, help } = commandOf(argv);
    if (command === "migrate-state") return await migrateHere(deps, args, help);
    if (!help && command !== "help" && command !== "version" && command !== "--version") assertStateMoved(deps.env);
    if (!help && command === "run") return await runHere(deps, args, globals);
    if (!help && command === "get" && passwordFdOption(args) !== undefined) return await getWithFd(deps, command, args, globals);
    return (await runWindows(deps, argv, false)).code;
  } catch (err) {
    const exitCode = (err as { exitCode?: unknown }).exitCode;
    const code = err instanceof LaunchError ? err.code : typeof exitCode === "number" ? exitCode : 1;
    deps.io.stderr(`arashouse: ${err instanceof Error ? err.message : String(err)}\n`);
    return code;
  }
}
