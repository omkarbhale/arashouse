// The WSL launcher for real (T10): from WSL, through interop, on this host's Windows Node, against a fake pool whose
// state is in a Windows temp folder (ARASHOUSE_LAUNCHER=always launches it for the fake host). It runs only in WSL with
// a Windows Node, and never touches the pool: the fake host, a state of its own, and the runtime folder kept in that
// temp folder too (LOCALAPPDATA). get, run (in WSL), deploy-code from a WSL path, extract to a WSL path, status, return.

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIDE } from "../src/host/platform.js";
import { DEFAULT_WINDOWS_NODE } from "../src/host/broker-transport.js";
import { repoRoot } from "./helpers.js";

const run = promisify(execFile);
const onHost = SIDE === "wsl" && existsSync(DEFAULT_WINDOWS_NODE) && existsSync("/mnt/c/Windows");

describe.skipIf(!onHost)("the WSL launcher, through interop to the Windows build (this host only)", { timeout: 120_000 }, () => {
  let work: string;
  let win: string;
  let bin: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "arashouse-launcher-e2e-"));
    const windowsTemp = execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { encoding: "utf8", cwd: "/mnt/c" }).trim();
    const mount = execFileSync("wslpath", ["-u", windowsTemp], { encoding: "utf8" }).trim();
    win = await mkdtemp(join(mount, "arashouse-launcher-e2e-"));
    const build = join(work, "build");
    await run(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", join(build, "dist")], { cwd: repoRoot });
    await cp(join(repoRoot, "package.json"), join(build, "package.json"));
    bin = join(build, "dist", "cli", "index.js");
    env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME,
      ARASHOUSE_LAUNCHER: "always",
      ARASHOUSE_HOST: "fake",
      ARASHOUSE_RESET_WORKER: "off",
      ARASHOUSE_HOME: join(win, "state"),
      ARASHOUSE_LOCAL_ROOT: join(win, "root"),
      LOCALAPPDATA: join(win, "local"),
    };
  }, 180_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
    if (win) await rm(win, { recursive: true, force: true });
  });

  const cli = async (...args: string[]) => {
    try {
      return { code: 0, ...(await run(process.execPath, [bin, ...args], { env, encoding: "utf8", cwd: work })) };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };

  it("leases, runs in WSL, deploys from and extracts to WSL paths, and returns, on the Windows side's state", async () => {
    expect((await cli("provision", "23", "1")).code).toBe(0);
    // The runtime the Windows side runs from was put under LOCALAPPDATA, and the state on the Windows drive.
    expect((await readdir(join(win, "local", "arashouse", "runtime"))).filter((n) => /^[0-9a-f]{16}$/.test(n))).toHaveLength(1);
    expect(existsSync(join(win, "state", "state.json"))).toBe(true);

    const got = await cli("get", "23", "--holder", "launcher-e2e", "--json");
    expect(got.code, got.stderr).toBe(0);
    const grant = JSON.parse(got.stdout) as { slot: string; lease_id: string; url: string; password: string };
    expect(grant.slot).toBe("23-01");
    expect(grant.password.length).toBeGreaterThan(10);

    const seen = join(work, "seen.txt");
    const ran = await cli("run", "--lease", grant.lease_id, "--", "sh", "-c", 'printf "%s %s %s" "$(uname -s)" "$ARASHOUSE_SLOT" "$ARAS_URL" > "$1"; exit 4', "sh", seen);
    expect(ran.code).toBe(4);
    expect(await readFile(seen, "utf8")).toBe(`Linux 23-01 ${grant.url}`);

    const src = join(work, "overlay");
    await mkdir(join(src, "Client", "scripts"), { recursive: true });
    await writeFile(join(src, "Client", "scripts", "fix.js"), "// fix");
    const deployed = await cli("deploy-code", "--lease", grant.lease_id, src);
    expect(deployed.code, deployed.stderr).toBe(0);
    expect(deployed.stdout).toContain("deployed code into 23-01");

    // The fake host's slot tree, as a test makes it; extract copies it into WSL's disk from the Windows side.
    const tree = join(win, "state", "fake-host", "slots", "23", "01", "Innovator", "Client");
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, "app.js"), "app");
    const out = join(work, "extracted");
    const extracted = await cli("extract", "code", "--lease", grant.lease_id, "Innovator/Client", "--to", out);
    expect(extracted.code, extracted.stderr).toBe(0);
    expect(await readFile(join(out, "Client", "app.js"), "utf8")).toBe("app");

    expect((await cli("return", grant.lease_id, "--quiet")).code).toBe(0);
    const status = JSON.parse((await cli("status", "--json")).stdout) as { slots: { slot: string; status: string }[] };
    expect(status.slots.map((s) => [s.slot, s.status])).toEqual([["23-01", "dirty"]]);
  });

  it("refuses a state home on WSL's disk, before it starts anything on Windows", async () => {
    const saved = env.ARASHOUSE_HOME;
    env.ARASHOUSE_HOME = join(work, "wsl-home");
    try {
      const r = await cli("status");
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/on WSL's disk: the pool's state lives on Windows/);
    } finally {
      env.ARASHOUSE_HOME = saved;
    }
  });
});
