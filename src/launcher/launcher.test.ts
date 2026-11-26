import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../core/exit-codes.js";
import type { Secret } from "../core/secret.js";
import {
  LAUNCH_ATTEMPTS,
  findApkgScript,
  hostAddressFor,
  launcherApplies,
  runLauncher,
  runtimeId,
  windowsEnvironment,
  windowsLocalAppData,
  checkoutMedia,
  windowsPathFor,
  type LauncherDeps,
  type Networking,
  type Spawner,
} from "./launcher.js";

const dir = mkdtempSync(join(tmpdir(), "arashouse-launcher-"));
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A build to launch: `dist/` with a file or two, and package.json. */
function fakeBuild(name: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  writeFileSync(join(root, "dist", "cli", "index.js"), "// cli\n");
  writeFileSync(join(root, "dist", "cli", "index.js.map"), "{}");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "arashouse", version: "0.0.0" }));
  return root;
}

const nat: Networking = { mode: () => "nat", gateway: () => "172.19.0.1" };

// Built from parts, so this file holds no secret-shaped literal (test/tracked-files.test.ts).
const PW = ["pw", "from", "windows"].join("-");
const GRANT_PW = ["the", "password"].join("-");

describe("when the launcher runs", () => {
  const yes = () => true;
  it("in WSL with a Windows Node, for every host but the fake one (unless asked)", () => {
    expect(launcherApplies({}, "wsl", yes)).toBe(true);
    expect(launcherApplies({ ARASHOUSE_HOST: "broker" }, "wsl", yes)).toBe(true);
    expect(launcherApplies({ ARASHOUSE_HOST: "fake" }, "wsl", yes)).toBe(false);
    expect(launcherApplies({ ARASHOUSE_HOST: "fake", ARASHOUSE_LAUNCHER: "always" }, "wsl", yes)).toBe(true);
  });

  it("never natively, on plain Linux, or in a WSL with no Windows Node (nothing there could be reached)", () => {
    expect(launcherApplies({}, "windows", yes)).toBe(false);
    expect(launcherApplies({}, "linux", yes)).toBe(false);
    const seen: string[] = [];
    expect(launcherApplies({ ARASHOUSE_WINDOWS_NODE: "/x/node.exe" }, "wsl", (p) => (seen.push(p), false))).toBe(false);
    expect(seen).toEqual(["/x/node.exe"]);
  });
});

// The launcher runs in WSL only, on POSIX paths: the rest of this file is not for a Windows runner.
const posix = process.platform === "win32" ? describe.skip : describe;

posix("what the Windows process is given", () => {
  it("opens a /mnt path as its drive, and anything else of WSL's through \\\\wsl.localhost", () => {
    expect(windowsPathFor("/mnt/c/Users/me/x.bak", "Ubuntu")).toBe("C:\\Users\\me\\x.bak");
    expect(windowsPathFor("/home/me/media", "Ubuntu")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\media");
    expect(windowsPathFor("media", "Ubuntu", "/home/me")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\media");
  });

  it("carries the distribution, the paths as Windows reads them and the plain settings in WSLENV; never the launcher's own", () => {
    const env = windowsEnvironment(
      {
        WSLENV: "WT_SESSION:",
        ARASHOUSE_MEDIA: "/home/me/media",
        ARASHOUSE_HOME: "/mnt/c/Users/me/state",
        ARASHOUSE_DEBUG: "1",
        ARAS_PKG_ENGINE: "14.35",
        ARASHOUSE_WINDOWS_NODE: "/mnt/c/node.exe",
        ARASHOUSE_APKG: "/opt/libs-js/dist/cli.js",
        PATH: "",
      },
      "Ubuntu",
      { net: nat, checkoutMedia: () => "/home/me/arashouse/media" },
    );
    expect(env).toEqual({
      ARASHOUSE_WSL_DISTRO: "Ubuntu",
      ARASHOUSE_MEDIA: "\\\\wsl.localhost\\Ubuntu\\home\\me\\media",
      ARASHOUSE_HOME: "C:\\Users\\me\\state",
      ARASHOUSE_APKG: "\\\\wsl.localhost\\Ubuntu\\opt\\libs-js\\dist\\cli.js",
      ARASHOUSE_DEBUG: "1",
      ARAS_PKG_ENGINE: "14.35",
      ARASHOUSE_HOST_ADDR: "172.19.0.1",
      WSLENV: "WT_SESSION::ARASHOUSE_WSL_DISTRO:ARASHOUSE_DEBUG:ARAS_PKG_ENGINE:ARASHOUSE_MEDIA:ARASHOUSE_APKG:ARASHOUSE_HOME:ARASHOUSE_HOST_ADDR",
    });
  });

  it("passes the launcher's own checkout's media/ as the last resort, only when ARASHOUSE_MEDIA is not set", () => {
    const env = windowsEnvironment({ PATH: "" }, "Ubuntu", { net: nat, checkoutMedia: () => "/home/me/arashouse/media" });
    expect(env.ARASHOUSE_CHECKOUT_MEDIA).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\arashouse\\media");
    expect(String(env.WSLENV)).toContain("ARASHOUSE_CHECKOUT_MEDIA");
    expect(windowsEnvironment({ PATH: "" }, "Ubuntu", { net: nat, checkoutMedia: () => undefined })).not.toHaveProperty("ARASHOUSE_CHECKOUT_MEDIA");
    // This checkout is arashouse's: its media/ is found (media/README.md is tracked).
    expect(checkoutMedia(repoRoot)).toMatch(/\/media$/);
  });

  it("refuses a state home on WSL's disk: the pool's state lives on Windows", () => {
    expect(() => windowsEnvironment({ ARASHOUSE_HOME: "/home/me/.arashouse", PATH: "" }, "Ubuntu", { net: nat })).toThrow(/on WSL's disk: the pool's state lives on Windows/);
  });

  it("builds slot URLs with the address WSL reaches the host at: the caller's, the NAT gateway, or none when mirrored", () => {
    expect(hostAddressFor({ ARASHOUSE_HOST_ADDR: "10.0.0.5" }, nat)).toBe("10.0.0.5");
    expect(hostAddressFor({}, nat)).toBe("172.19.0.1");
    expect(hostAddressFor({}, { mode: () => "mirrored", gateway: () => "192.168.1.1" })).toBeUndefined();
    expect(hostAddressFor({}, { mode: () => undefined, gateway: () => undefined })).toBeUndefined();
  });

  it("finds libs-js's CLI on PATH as the script an npm link points to", () => {
    const bin = join(dir, "bin");
    mkdirSync(join(dir, "libs", "dist"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(dir, "libs", "dist", "cli.js"), "");
    symlinkSync(join(dir, "libs", "dist", "cli.js"), join(bin, "aras-pkg"));
    expect(findApkgScript({ PATH: `/nowhere:${bin}` })).toBe(join(dir, "libs", "dist", "cli.js"));
    expect(findApkgScript({ PATH: "/nowhere" })).toBeUndefined();
  });

  it("asks Windows for %LOCALAPPDATA% once and keeps it; a LOCALAPPDATA set here wins", () => {
    const cacheHome = join(dir, "cache");
    let asked = 0;
    const ask = () => (asked++, "C:\\Windows");
    const env = { XDG_CACHE_HOME: cacheHome };
    // C:\Windows exists on any host this runs on with a C: drive; the answer is kept only when it names a drive path.
    expect(windowsLocalAppData(env, "Ubuntu", ask)).toBe("C:\\Windows");
    // Kept, it is used while it names a folder this side can see (on a runner without /mnt/c it is asked again).
    expect(windowsLocalAppData(env, "Ubuntu", () => "not asked")).toBe(existsSync("/mnt/c/Windows") ? "C:\\Windows" : undefined);
    expect(asked).toBe(1);
    expect(windowsLocalAppData({ ...env, LOCALAPPDATA: "/mnt/d/local" }, "Ubuntu", ask)).toBe("D:\\local");
    expect(windowsLocalAppData({ XDG_CACHE_HOME: join(dir, "cache2") }, "Ubuntu", () => "%LOCALAPPDATA%")).toBeUndefined();
  });

  it("names each build's runtime by its files, not their source maps", () => {
    const a = fakeBuild("a");
    const b = fakeBuild("b");
    expect(runtimeId(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(runtimeId(a)).toBe(runtimeId(b));
    writeFileSync(join(b, "dist", "cli", "index.js.map"), "{changed}");
    expect(runtimeId(b)).toBe(runtimeId(a));
    writeFileSync(join(b, "dist", "cli", "index.js"), "// changed\n");
    expect(runtimeId(b)).not.toBe(runtimeId(a));
  });
});

/** A spawner whose Windows process answers with `answer(args)`: what it prints and its exit code. */
function fakeWindows(answer: (args: readonly string[], call: number) => { stdout?: string; stderr?: string; code: number }) {
  const calls: { node: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: Spawner = (node, args, env) => {
    calls.push({ node, args, env });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, kill: () => true });
    const { stdout: out = "", stderr: err = "", code } = answer(args, calls.length);
    setImmediate(() => {
      stdout.end(out);
      stderr.end(err);
      setImmediate(() => child.emit("close", code, null));
    });
    return child;
  };
  return { spawn, calls };
}

function launch(spawn: Spawner, extra: Partial<LauncherDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: LauncherDeps = {
    // A HOME with no ~/.arashouse: the pool's state is not WSL's (assertStateMoved).
    env: { WSL_DISTRO_NAME: "Ubuntu", PATH: process.env.PATH, HOME: join(dir, "wsl-home"), ARASHOUSE_WINDOWS_NODE: "/mnt/c/Program Files/nodejs/node.exe" },
    io: { stdout: (c) => void out.push(c), stderr: (c) => void err.push(c) },
    spawn,
    net: nat,
    root: fakeBuild("launched"),
    sleep: async () => undefined,
    // No runtime copy yet: every launch goes through the entry, unless a test says otherwise.
    localAppData: () => undefined,
    ...extra,
  };
  return { deps, out, err };
}

posix("runLauncher", () => {
  it("runs the Windows entry with the build's runtime id and the arguments as given, passing output and exit code through", async () => {
    const w = fakeWindows(() => ({ stdout: "23-01 free\n", stderr: "arashouse: a note\n", code: 3 }));
    const l = launch(w.spawn);
    expect(await runLauncher(["status", "--verbose"], l.deps)).toBe(3);
    expect(l.out.join("")).toBe("23-01 free\n");
    expect(l.err.join("")).toBe("arashouse: a note\n");
    const [call] = w.calls;
    expect(call?.node).toBe("/mnt/c/Program Files/nodejs/node.exe");
    expect(call?.args[0]).toMatch(/^\\\\wsl\.localhost\\Ubuntu\\.*\\launched\\dist\\launcher\\windows-entry\.js$/);
    expect(call?.args[1]).toMatch(/^[0-9a-f]{16}$/);
    expect(call?.args.slice(2)).toEqual(["status", "--verbose"]);
    expect(call?.env).toMatchObject({ ARASHOUSE_WSL_DISTRO: "Ubuntu", ARASHOUSE_HOST_ADDR: "172.19.0.1" });
    expect(String(call?.env.WSLENV)).toContain("ARASHOUSE_WSL_DISTRO");
  });

  it("starts the build's runtime copy by its Windows path once it exists, not the entry", async () => {
    const w = fakeWindows(() => ({ code: 0 }));
    const seen: string[] = [];
    const l = launch(w.spawn, { localAppData: () => "C:\\Users\\me\\AppData\\Local", exists: (p) => (seen.push(p), true) });
    expect(await runLauncher(["status"], l.deps)).toBe(0);
    const args = w.calls[0]?.args ?? [];
    expect(args[0]).toMatch(/^C:\\Users\\me\\AppData\\Local\\arashouse\\runtime\\[0-9a-f]{16}\\dist\\cli\\index\.js$/);
    expect(args.slice(1)).toEqual(["status"]);
    expect(seen[0]).toMatch(/^\/mnt\/c\/Users\/me\/AppData\/Local\/arashouse\/runtime\/[0-9a-f]{16}\/runtime\.json$/);
  });

  it("starts node.exe again when WSL's interop could not, keeping WSL's line back, and gives up after a few", async () => {
    const vsock = "<3>WSL (1234 - ) ERROR: UtilAcceptVsock:273: accept4 failed 110\n";
    const flaky = fakeWindows((_args, call) => (call === 1 ? { stderr: vsock, code: 1 } : { stdout: "ok\n", code: 0 }));
    const l = launch(flaky.spawn);
    expect(await runLauncher(["status"], l.deps)).toBe(0);
    expect(flaky.calls).toHaveLength(2);
    expect(l.err.join("")).toBe("");

    const dead = fakeWindows(() => ({ stderr: vsock, code: 1 }));
    const d = launch(dead.spawn);
    expect(await runLauncher(["status"], d.deps)).toBe(EXIT_CODES.hostUnreachable);
    expect(dead.calls).toHaveLength(LAUNCH_ATTEMPTS);
    expect(d.err.join("")).toMatch(/WSL could not start .*UtilAcceptVsock/);

    // Output from arashouse itself means node.exe ran: never again, whatever else is on stderr.
    const ran = fakeWindows(() => ({ stderr: `${vsock}arashouse: cannot reach the broker\n`, code: 6 }));
    expect(await runLauncher(["status"], launch(ran.spawn).deps)).toBe(6);
    expect(ran.calls).toHaveLength(1);
  });

  it("runs `run`'s command here, in WSL, with the environment the Windows side gives, and its exit code", async () => {
    const leaseEnv = { ARAS_URL: "http://172.19.0.1/ah-23-01", ARAS_PASSWORD: PW, ARASHOUSE_SLOT: "23-01" };
    const w = fakeWindows((args) => (args.includes("env") ? { stdout: JSON.stringify(leaseEnv), code: 0 } : { code: 99 }));
    const l = launch(w.spawn);
    const lease = "a".repeat(32);
    const script = `process.exit(process.env.ARAS_PASSWORD === '${PW}' && process.env.ARASHOUSE_SLOT === '23-01' ? 5 : 1)`;
    expect(await runLauncher(["--verbose", "run", "--lease", lease, "--", process.execPath, "-e", script], l.deps)).toBe(5);
    expect(w.calls.map((c) => c.args.slice(2))).toEqual([["--verbose", "env", "--lease", lease, "--json"]]);
    expect(l.out.join("") + l.err.join("")).not.toContain(PW);
  });

  it("passes a `run` the Windows side refuses through with its exit code, and runs nothing", async () => {
    const w = fakeWindows(() => ({ stderr: "arashouse: lease aaaaaaaa is not held\n", code: EXIT_CODES.leaseMismatch }));
    const l = launch(w.spawn);
    expect(await runLauncher(["run", "--lease", "a".repeat(32), "--", "false"], l.deps)).toBe(EXIT_CODES.leaseMismatch);
    expect(l.err.join("")).toContain("is not held");
  });

  it("keeps get --password-fd here: the Windows side's --json, the password to this side's descriptor only", async () => {
    const grant = { slot: "23-01", flavor: "23", engine: "14.0.7", holder: "t", url: "http://172.19.0.1/ah-23-01", database: "arashouse_23_01", user: "root", lease_id: "b".repeat(32), password: GRANT_PW };
    const w = fakeWindows(() => ({ stdout: JSON.stringify(grant), code: 0 }));
    const written: [number, string][] = [];
    const passwordFd = { parse: (text: string) => Number(text), write: (fd: number, secret: Secret) => void written.push([fd, secret.reveal()]) };
    const human = launch(w.spawn, { passwordFd });
    expect(await runLauncher(["get", "23", "--holder", "t", "--password-fd", "3"], human.deps)).toBe(0);
    expect(w.calls[0]?.args.slice(2)).toEqual(["get", "23", "--holder", "t", "--json"]);
    expect(written).toEqual([[3, GRANT_PW]]);
    expect(human.out.join("")).toContain("password:  written to descriptor 3");
    expect(human.out.join("")).not.toContain(GRANT_PW);

    const json = launch(w.spawn, { passwordFd });
    expect(await runLauncher(["get", "23", "--holder", "t", "--json", "--password-fd", "4"], json.deps)).toBe(0);
    const printed = JSON.parse(json.out.join("")) as Record<string, unknown>;
    expect(printed).not.toHaveProperty("password");
    expect(printed.lease_id).toBe("b".repeat(32));
    expect(written.at(-1)).toEqual([4, GRANT_PW]);

    // The `=` form, as the CLI's own parser takes it.
    const eq = launch(w.spawn, { passwordFd });
    expect(await runLauncher(["get", "23", "--holder", "t", "--password-fd=5"], eq.deps)).toBe(0);
    expect(w.calls.at(-1)?.args.slice(-5)).toEqual(["get", "23", "--holder", "t", "--json"]);
    expect(written.at(-1)).toEqual([5, GRANT_PW]);
  });

  it("returns the lease when the password cannot be written, as the CLI does", async () => {
    const grant = { slot: "23-01", lease_id: "c".repeat(32), password: PW };
    const w = fakeWindows((args) => (args.includes("return") ? { code: 0 } : { stdout: JSON.stringify(grant), code: 0 }));
    const l = launch(w.spawn, { passwordFd: { parse: () => 3, write: () => { throw new Error("EBADF"); } } });
    expect(await runLauncher(["get", "23", "--holder", "t", "--password-fd", "3"], l.deps)).toBe(EXIT_CODES.usage);
    expect(w.calls.map((c) => c.args.slice(2))).toEqual([["get", "23", "--holder", "t", "--json"], ["return", "c".repeat(32), "--quiet"]]);
    expect(l.err.join("")).toMatch(/could not be written to descriptor 3; the lease of 23-01 was returned/);
  });

  it("refuses while the pool's state is still WSL's ~/.arashouse, unless ARASHOUSE_HOME names a state; help and version still run", async () => {
    const home = join(dir, "unmoved");
    mkdirSync(join(home, ".arashouse"), { recursive: true });
    writeFileSync(join(home, ".arashouse", "state.json"), "{}");
    const w = fakeWindows(() => ({ stdout: "ran\n", code: 0 }));
    const env = { WSL_DISTRO_NAME: "Ubuntu", PATH: "", HOME: home, ARASHOUSE_WINDOWS_NODE: "/x/node.exe" };
    const l = launch(w.spawn, { env });
    expect(await runLauncher(["get", "23", "--holder", "t"], l.deps)).toBe(1);
    expect(l.err.join("")).toMatch(/the pool's state is still WSL's \(.*unmoved\/\.arashouse\/state\.json\).*move it there first.*nothing was done/);
    expect(w.calls).toEqual([]);
    for (const args of [["version"], ["help", "get"], ["get", "--help"]]) expect(await runLauncher(args, launch(w.spawn, { env }).deps)).toBe(0);
    expect(await runLauncher(["status"], launch(w.spawn, { env: { ...env, ARASHOUSE_HOME: "/mnt/c/state" } }).deps)).toBe(0);
    // Moved (WSL's renamed out of the way): it runs.
    rmSync(join(home, ".arashouse", "state.json"));
    expect(await runLauncher(["status"], launch(w.spawn, { env }).deps)).toBe(0);
  });

  it("says what to do when there is no Windows Node or no distribution name", async () => {
    const l = launch(undefined as unknown as Spawner, { spawn: undefined, env: { WSL_DISTRO_NAME: "Ubuntu", HOME: join(dir, "wsl-home"), ARASHOUSE_WINDOWS_NODE: join(dir, "no-node.exe") } });
    expect(await runLauncher(["status"], l.deps)).toBe(1);
    expect(l.err.join("")).toMatch(/arashouse runs on Windows, and there is no Windows Node at .*no-node\.exe: install Node 20/);
    const w = fakeWindows(() => ({ code: 0 }));
    const n = launch(w.spawn, { env: { HOME: join(dir, "wsl-home"), ARASHOUSE_WINDOWS_NODE: "/x/node.exe" } });
    expect(await runLauncher(["status"], n.deps)).toBe(1);
    expect(n.err.join("")).toMatch(/WSL_DISTRO_NAME is not set/);
  });
});
