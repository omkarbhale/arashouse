// The CLI surface (ticket 15), tested by spawning the built binary against the fake host
// (`ARASHOUSE_HOST=fake`). Each test gets its own ARASHOUSE_HOME, seeded with free slots.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../src/core/exit-codes.js";
import type { FlavorKey } from "../src/core/flavors.js";
import { SECRET_REQUIRED_EXIT_CODE } from "../src/core/licence.js";
import { StateStore } from "../src/core/store.js";
import { buildZip } from "../src/core/zip.fixture.js";
import { fakeGoldenHash } from "../src/host/fake.js";
import { repoRoot } from "./helpers.js";

const BIN = join(repoRoot, "dist", "cli", "index.js");

// Each test spawns the binary several times; under the full suite's load that outruns the default.
vi.setConfig({ testTimeout: 60_000 });

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let home: string;
let media: string;
/** Every stdout and stderr the binary printed in the current test, for the password grep. */
let printed: string[];

function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        // No detached reset worker unless a test asks for one, so none outlives its test's home.
        env: { PATH: process.env.PATH, HOME: home, ARASHOUSE_HOME: home, ARASHOUSE_HOST: "fake", ARASHOUSE_MEDIA: media, ARASHOUSE_RESET_WORKER: "off", ARASHOUSE_WINDOWS_NODE: join(home, "no-node.exe"), ARASHOUSE_BROKER_TOKEN_FILE: join(home, "no-broker.token"), ...env },
        encoding: "utf8",
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        printed.push(stdout, stderr);
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

async function seed(spec: Partial<Record<FlavorKey, number>>): Promise<void> {
  const store = new StateStore({ home });
  for (const [flavor, count] of Object.entries(spec) as [FlavorKey, number][]) {
    for (let n = 1; n <= count; n++) {
      await store.update((tx) => {
        const slot = tx.addSlot({ flavor, slot: n });
        tx.transition(slot.id, { to: "free", golden_hash: fakeGoldenHash(flavor), reset_ms: 1500 });
      });
    }
  }
}

async function validator(name: string) {
  const schema = JSON.parse(await readFile(join(repoRoot, "docs", "schemas", name), "utf8")) as object;
  return new Ajv2020({ strict: true, allErrors: true }).compile(schema);
}

interface Grant {
  slot: string;
  lease_id: string;
  password: string;
}

async function lease(flavor: FlavorKey, holder = "task-a"): Promise<Grant> {
  const r = await cli(["get", flavor, "--holder", holder, "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Grant;
}

// Built asynchronously: a synchronous build would block the test worker's event loop for its duration.
beforeAll(async () => {
  await promisify(execFile)(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], {
    cwd: repoRoot,
  });
}, 180_000);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-cli-"));
  media = join(home, "media");
  printed = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("get --json", () => {
  it("prints the lease contract, valid against its schema, and nothing else on stdout", async () => {
    await seed({ "23": 1 });
    const r = await cli(["get", "23", "--holder", "task-a", "--json"]);
    expect(r.code).toBe(0);
    const grant = JSON.parse(r.stdout) as Grant & Record<string, unknown>;
    const validate = await validator("get.schema.json");
    expect(validate(grant), JSON.stringify(validate.errors)).toBe(true);
    expect(grant).toMatchObject({ slot: "23-01", flavor: "23", engine: "14.0.7", database: "arashouse_23_01", user: "root", holder: "task-a" });
    expect(r.stderr).toContain(`arashouse return ${grant.lease_id}`);
    expect(r.stderr).not.toContain(grant.password);
  });

  it("without --json shows the connection and the lease id but not the password", async () => {
    await seed({ "12sp9": 1 });
    const r = await cli(["get", "12sp9", "--holder", "task-a"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/lease id: +[0-9a-f]{32}/);
    expect(r.stdout).toContain("password:  not shown");
    const leaseId = /lease id: +([0-9a-f]{32})/.exec(r.stdout)![1]!;
    const stored = await readFile(join(home, "leases", leaseId), "utf8");
    expect(r.stdout + r.stderr).not.toContain(stored);
  });
});

describe("get --restore", () => {
  it("restores a backup file into the lease, stages it in a folder of its own, and status shows restore:custom", async () => {
    await seed({ "12sp9": 1 });
    const backup = join(home, "scratch.bak");
    await writeFile(backup, "not really a backup");
    const r = await cli(["get", "12sp9", "--holder", "task-a", "--restore", backup, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const grant = JSON.parse(r.stdout) as Grant;
    expect(grant.slot).toBe("12sp9-01");
    // The staged copy is gone once the lease is handed over.
    expect(existsSync(join(home, "fake-staging", grant.lease_id))).toBe(false);
    const status = JSON.parse((await cli(["status", "--json"])).stdout) as { slots: { slot: string; bootstrap: string | null }[] };
    expect(status.slots).toEqual([expect.objectContaining({ slot: "12sp9-01", bootstrap: "restore:custom" })]);
    expect((await cli(["status"])).stdout).toMatch(/^12sp9-01 .* restore:custom$/m);
    expect(await readFile(join(home, "state.json"), "utf8")).not.toContain("scratch.bak");
  });

  it("restores a profile from media/<flavor>/profiles/", async () => {
    await seed({ "12sp9": 1 });
    await mkdir(join(media, "12sp9", "profiles"), { recursive: true });
    await writeFile(join(media, "12sp9", "profiles", "demo.bak"), "profile");
    expect((await cli(["get", "12sp9", "--holder", "task-a", "--restore", "demo"])).code).toBe(0);
    const status = JSON.parse((await cli(["status", "--json"])).stdout) as { slots: { bootstrap: string | null }[] };
    expect(status.slots[0]?.bootstrap).toBe("restore:profile:demo");
  });

  it("refuses a missing file or profile, and an override without --restore, before any slot is leased (exit 2)", async () => {
    await seed({ "12sp9": 1 });
    for (const args of [
      ["--restore", join(home, "absent.bak")],
      ["--restore", "C:\\nowhere\\absent.bak"],
      ["--restore", "nosuchprofile"],
      ["--restore", "bad name"],
      ["--skip-version-check"],
      ["--allow-foreign-origin"],
    ]) {
      const r = await cli(["get", "12sp9", "--holder", "task-a", ...args]);
      expect(r.code, args.join(" ")).toBe(EXIT_CODES.usage);
    }
    const status = JSON.parse((await cli(["status", "--json"])).stdout) as { slots: { status: string }[] };
    expect(status.slots[0]?.status).toBe("free");
  });
});

describe("get --password-fd", () => {
  /** The binary with a pipe on descriptor 3; answers what it printed and what it wrote there. */
  function cliFd3(args: readonly string[]): Promise<Result & { fd3: string }> {
    return new Promise((resolve) => {
      const env = { PATH: process.env.PATH, HOME: home, ARASHOUSE_HOME: home, ARASHOUSE_HOST: "fake", ARASHOUSE_MEDIA: media, ARASHOUSE_RESET_WORKER: "off" };
      const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
      const out = { stdout: "", stderr: "", fd3: "" };
      child.stdout!.setEncoding("utf8").on("data", (d: string) => (out.stdout += d));
      child.stderr!.setEncoding("utf8").on("data", (d: string) => (out.stderr += d));
      (child.stdio[3] as Readable).setEncoding("utf8").on("data", (d: string) => (out.fd3 += d));
      child.on("close", (code) => {
        printed.push(out.stdout, out.stderr);
        resolve({ code: code ?? -1, ...out });
      });
    });
  }

  const posixOnly = it.skipIf(process.platform === "win32");

  posixOnly("writes the password to the descriptor, and --json leaves it out", async () => {
    await seed({ "23": 1 });
    const r = await cliFd3(["get", "23", "--holder", "task-a", "--json", "--password-fd", "3"]);
    expect(r.code, r.stderr).toBe(0);
    const grant = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(grant).not.toHaveProperty("password");
    const validate = await validator("get.schema.json");
    expect(validate(grant), JSON.stringify(validate.errors)).toBe(true);
    const password = r.fd3.trimEnd();
    expect(r.fd3).toMatch(/^[A-Za-z0-9_-]{22}\n$/);
    expect(await readFile(join(home, "leases", grant.lease_id as string), "utf8")).toBe(password);
    expect(r.stdout + r.stderr).not.toContain(password);
  });

  posixOnly("says where the password went without --json", async () => {
    await seed({ "23": 1 });
    const r = await cliFd3(["get", "23", "--holder", "task-a", "--password-fd", "3"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("password:  written to descriptor 3");
    expect(r.stdout).not.toContain(r.fd3.trimEnd());
  });

  it("refuses 0 to 2 and a descriptor that is not open, before it takes a lease", async () => {
    await seed({ "23": 1 });
    for (const fd of ["1", "2", "x", "1024"]) {
      const r = await cli(["get", "23", "--holder", "task-a", "--password-fd", fd]);
      expect(r.code, fd).toBe(EXIT_CODES.usage);
      expect(r.stderr).toContain("--password-fd must be a descriptor from 3 to 1023");
    }
    // Without a descriptor 3 from the caller, 3 and up are Node's own (its event loop's): never written to. On Windows,
    // where no descriptor can be told inherited, the option is refused altogether.
    for (const fd of ["3", "9"]) {
      const closed = await cli(["get", "23", "--holder", "task-a", "--password-fd", fd]);
      expect(closed.code, fd).toBe(EXIT_CODES.usage);
      expect(closed.stderr).toContain(process.platform === "win32" ? "--password-fd is not available on Windows" : `--password-fd ${fd} is not open`);
    }
    expect((await new StateStore({ home }).read()).slots["23-01"]?.status).toBe("free");
  });
});

describe("get --code and deploy-code", () => {
  /** A one-file client overlay, and the install root the CLI stages into, both under the test's home. */
  async function overlay(): Promise<{ src: string; env: NodeJS.ProcessEnv }> {
    const src = join(home, "overlay");
    await mkdir(join(src, "Client", "scripts"), { recursive: true });
    await writeFile(join(src, "Client", "scripts", "fix.js"), "// fixed");
    const root = join(home, "root");
    await mkdir(root);
    return { src, env: { ARASHOUSE_LOCAL_ROOT: root } };
  }

  async function slotOf(id: string) {
    return (await new StateStore({ home }).read()).slots[id];
  }

  it("deploys after the lease, prints what it did in the contract, and records it on the lease without contents", async () => {
    await seed({ "12sp9": 1 });
    const { src, env } = await overlay();
    const r = await cli(["get", "12sp9", "--holder", "t", "--json", "--code", src, "--code", `${src}:Innovator/Client`], env);
    expect(r.code, r.stderr).toBe(0);
    const grant = JSON.parse(r.stdout) as Grant & { bootstrap: { code: { subpath: string; ok: boolean }[] } };
    const validate = await validator("get.schema.json");
    expect(validate(grant), JSON.stringify(validate.errors)).toBe(true);
    expect(grant.bootstrap.code.map((c) => [c.subpath, c.ok])).toEqual([
      ["Innovator", true],
      ["Innovator/Client", true],
    ]);
    const bootstrap = (await slotOf("12sp9-01"))?.lease?.bootstrap;
    expect(bootstrap).toMatchObject({ code_deploys: 2, code: expect.stringMatching(/^\d+ files, manifest [0-9a-f]{64}$/) });
    expect(JSON.stringify(bootstrap)).not.toContain("fixed");
    expect(await readdir(join(home, "root", "staging"))).toEqual([]);
  });

  it("refuses a deploy a guard refuses before it takes a lease (exit 7)", async () => {
    await seed({ "12sp9": 1 });
    const { env } = await overlay();
    const cfg = join(home, "cfg");
    await mkdir(cfg);
    await writeFile(join(cfg, "InnovatorServerConfig.xml"), "<Innovator/>");
    const r = await cli(["get", "12sp9", "--holder", "t", "--json", "--code", `${cfg}:.`], env);
    expect(r.code).toBe(EXIT_CODES.refused);
    expect(r.stderr).toMatch(/--allow-config/);
    expect(r.stdout).toBe("");
    expect((await slotOf("12sp9-01"))?.status).toBe("free");
    for (const flag of ["--atomic", "--allow-config", "--allow-servers"]) {
      expect((await cli(["get", "12sp9", "--holder", "t", flag], env)).code, flag).toBe(EXIT_CODES.usage);
    }
  });

  it("keeps the lease and shows it when a deploy fails (exit 10); --atomic returns it instead", async () => {
    await seed({ "12sp9": 2 });
    const { src, env } = await overlay();
    const faults = { ARASHOUSE_FAKE_FAULTS: JSON.stringify([{ method: "deployCode", kind: "fail", error: "Retryable", message: "robocopy failed (16)" }]) };
    const kept = await cli(["get", "12sp9", "--holder", "t", "--json", "--code", src], { ...env, ...faults });
    expect(kept.code).toBe(EXIT_CODES.codeFailed);
    const grant = JSON.parse(kept.stdout) as Grant & { bootstrap: { code: { ok: boolean; detail: string }[] } };
    expect(grant.bootstrap.code).toEqual([expect.objectContaining({ ok: false, detail: "robocopy failed (16)" })]);
    expect(kept.stderr).toMatch(/the code deploy failed .*; the lease is still held/);
    expect((await slotOf(grant.slot))?.status).toBe("leased");

    const atomic = await cli(["get", "12sp9", "--holder", "t", "--json", "--atomic", "--code", src], { ...env, ...faults });
    expect(atomic.code).toBe(EXIT_CODES.codeFailed);
    expect(atomic.stdout).toBe("");
    expect(atomic.stderr).toMatch(/--atomic returned the lease, and the slot is reset/);
    expect((await slotOf("12sp9-02"))?.status).toBe("dirty");
  });

  it("deploys the code before the imports, and runs no import after a deploy that failed", async () => {
    await seed({ "12sp9": 2 });
    const { src, env } = await overlay();
    const dir = join(home, "packages", "p");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "imports.mf"), `exit=0\n<imports><package name="LIBSJS-SCRATCH-p" path="p\\Import" /></imports>\n`);
    const apkg = { ARASHOUSE_APKG: join(repoRoot, "test", "fixtures", "fake-aras-pkg.mjs"), FAKE_APKG_RECORD: join(home, "apkg-runs.jsonl") };
    const both = await cli(["get", "12sp9", "--holder", "t", "--json", "--code", src, "--import", join(dir, "imports.mf")], { ...env, ...apkg });
    expect(both.code, both.stderr).toBe(0);
    const grant = JSON.parse(both.stdout) as Record<string, unknown>;
    const validate = await validator("get.schema.json");
    expect(validate(grant), JSON.stringify(validate.errors)).toBe(true);
    expect(grant).toMatchObject({ bootstrap: { code: [{ ok: true }] }, imports: [{ exit_code: 0 }] });
    const events = (await readFile(join(home, "events.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event: string });
    expect(events.some((e) => e.event === "bootstrap")).toBe(true);

    const faults = { ARASHOUSE_FAKE_FAULTS: JSON.stringify([{ method: "deployCode", kind: "fail", error: "Retryable", message: "robocopy failed (16)" }]) };
    const failed = await cli(["get", "12sp9", "--holder", "t", "--json", "--code", src, "--import", join(dir, "imports.mf")], { ...env, ...apkg, ...faults });
    expect(failed.code).toBe(EXIT_CODES.codeFailed);
    expect(JSON.parse(failed.stdout)).not.toHaveProperty("imports");
    expect(failed.stderr).toMatch(/the lease is still held, and no import ran/);
    const runs = existsSync(join(home, "apkg-runs.jsonl")) ? (await readFile(join(home, "apkg-runs.jsonl"), "utf8")).trim().split("\n") : [];
    expect(runs).toHaveLength(1);
  });

  it("deploy-code deploys onto a lease already held, and refuses a lease that is not held", async () => {
    await seed({ "23": 1 });
    const { src, env } = await overlay();
    const grant = await lease("23");
    const r = await cli(["deploy-code", "--lease", grant.lease_id, "--json", src], env);
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as Record<string, unknown>;
    const validate = await validator("deploy-code.schema.json");
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report).toMatchObject({ slot: "23-01", code: [{ subpath: "Innovator", ok: true }] });
    expect((await slotOf("23-01"))?.lease?.bootstrap).toMatchObject({ code_deploys: 1 });
    expect((await cli(["deploy-code", "--lease", "f".repeat(32), src], env)).code).toBe(EXIT_CODES.leaseMismatch);
    expect((await cli(["deploy-code", "--lease", grant.lease_id], env)).code).toBe(EXIT_CODES.usage);
    expect((await cli(["deploy-code", src], env)).code).toBe(EXIT_CODES.usage);
    const evil = join(home, "evil.zip");
    await writeFile(evil, buildZip([{ name: "../x.js", data: "x" }]));
    expect((await cli(["deploy-code", "--lease", grant.lease_id, evil], env)).code).toBe(EXIT_CODES.refused);
  });
});

describe("get --git and git-baseline (ticket 53)", () => {
  /** The install root the CLI stages into, with a small `Innovator\` tree in the flavor's slot 01. */
  async function slotTree(flavor: FlavorKey, count = 1): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
    const root = join(home, "root");
    for (let n = 1; n <= count; n++) {
      const tree = join(root, "slots", flavor, `0${n}`, "Innovator");
      await mkdir(join(tree, "Client", "scripts"), { recursive: true });
      await mkdir(join(tree, "Server", "App_Data", "Certificates"), { recursive: true });
      await writeFile(join(tree, "Client", "scripts", "app.js"), "// app");
      await writeFile(join(tree, "Server", "App_Data", "Certificates", "InnovatorServer.pfx"), "pfx");
    }
    return { root, env: { ARASHOUSE_LOCAL_ROOT: root } };
  }

  async function slotOf(id: string) {
    return (await new StateStore({ home }).read()).slots[id];
  }

  it("commits the tree last, prints the baseline in the contract and records the commit on the lease", async () => {
    await seed({ "12sp9": 1 });
    const { root, env } = await slotTree("12sp9");
    const r = await cli(["get", "12sp9", "--holder", "t", "--json", "--git"], env);
    expect(r.code, r.stderr).toBe(0);
    const grant = JSON.parse(r.stdout) as Grant & { bootstrap: { git: { ok: boolean; commit: string; files: number; path: string } } };
    const validate = await validator("get.schema.json");
    expect(validate(grant), JSON.stringify(validate.errors)).toBe(true);
    expect(grant.bootstrap.git).toMatchObject({ ok: true, files: 2, path: "C:\\aras_installations\\slots\\12sp9\\01\\Innovator" });
    expect((await slotOf("12sp9-01"))?.lease?.bootstrap).toEqual({ git: grant.bootstrap.git.commit });
    expect(await readdir(join(root, "staging"))).toEqual([]);
    const human = await cli(["git-baseline", "--lease", grant.lease_id], env);
    expect(human.code).toBe(EXIT_CODES.refused);
    expect(human.stderr).toMatch(/already has a git baseline/);
  });

  it("refuses --code that writes the repository's place before it takes a lease, and deploy-code onto a baseline", async () => {
    await seed({ "12sp9": 1 });
    const { env } = await slotTree("12sp9");
    const src = join(home, "with-gitignore");
    await mkdir(src);
    await writeFile(join(src, ".gitignore"), "*\n");
    const r = await cli(["get", "12sp9", "--holder", "t", "--git", "--code", src], env);
    expect(r.code).toBe(EXIT_CODES.refused);
    expect(r.stderr).toMatch(/writes Innovator\/\.gitignore, which the git baseline makes/);
    expect((await slotOf("12sp9-01"))?.status).toBe("free");
    expect((await cli(["get", "12sp9", "--holder", "t", "--atomic"], env)).code).toBe(EXIT_CODES.usage);

    const missing = await cli(["get", "12sp9", "--holder", "t", "--git"], { ...env, ARASHOUSE_GIT: join(home, "no-git") });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/git could not be run/);
    expect((await slotOf("12sp9-01"))?.status).toBe("free");

    const grant = JSON.parse((await cli(["get", "12sp9", "--holder", "t", "--json", "--git"], env)).stdout) as Grant;
    const deploy = await cli(["deploy-code", "--lease", grant.lease_id, src], env);
    expect(deploy.code).toBe(EXIT_CODES.refused);
    expect(deploy.stderr).toMatch(/which the git baseline makes/);
  });

  it("git-baseline commits a lease already held, in its contract, and refuses a lease that is not held", async () => {
    await seed({ "35": 1 });
    const { env } = await slotTree("35");
    const grant = await lease("35");
    const r = await cli(["git-baseline", "--lease", grant.lease_id, "--json"], env);
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as Record<string, unknown>;
    const validate = await validator("git-baseline.schema.json");
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report).toMatchObject({ slot: "35-01", git: { ok: true, files: 2 } });
    expect((await cli(["git-baseline", "--lease", "f".repeat(32)], env)).code).toBe(EXIT_CODES.leaseMismatch);
    expect((await cli(["git-baseline"], env)).code).toBe(EXIT_CODES.usage);
  });

  it("keeps the lease when the baseline fails (exit 10); --atomic returns it", async () => {
    await seed({ "12sp9": 2 });
    const { env } = await slotTree("12sp9", 2);
    const faults = { ARASHOUSE_FAKE_FAULTS: JSON.stringify([{ method: "deployCode", kind: "fail", error: "Retryable", message: "robocopy failed (16)" }]) };
    const kept = await cli(["get", "12sp9", "--holder", "t", "--json", "--git"], { ...env, ...faults });
    expect(kept.code).toBe(EXIT_CODES.codeFailed);
    const grant = JSON.parse(kept.stdout) as Grant & { bootstrap: { git: { ok: boolean; detail: string } } };
    expect(grant.bootstrap.git).toMatchObject({ ok: false, detail: "robocopy failed (16)" });
    expect(kept.stderr).toMatch(/the git baseline failed .*; the lease is still held/);
    expect((await slotOf(grant.slot))?.status).toBe("leased");

    const atomic = await cli(["get", "12sp9", "--holder", "t", "--json", "--atomic", "--git"], { ...env, ...faults });
    expect(atomic.code).toBe(EXIT_CODES.codeFailed);
    expect(atomic.stdout).toBe("");
    expect(atomic.stderr).toMatch(/the git baseline of 12sp9-02 failed .*--atomic returned the lease/);
    expect((await slotOf("12sp9-02"))?.status).toBe("dirty");
  });
});

describe("env --lease", () => {
  it("prints the environment run gives, as JSON valid against its schema, only with --json", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    const r = await cli(["env", "--lease", grant.lease_id, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const env = JSON.parse(r.stdout) as Record<string, string>;
    const validate = await validator("env.schema.json");
    expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
    expect(env).toEqual({
      ARAS_URL: "http://127.0.0.1/ah-23-01",
      ARAS_DATABASE: "arashouse_23_01",
      ARAS_USER: "root",
      ARAS_PASSWORD: grant.password,
      ARASHOUSE_SLOT: "23-01",
      ARASHOUSE_FLAVOR: "23",
      ARAS_PKG_ENGINE: "14.0.7",
    });
    expect(r.stderr).not.toContain(grant.password);

    const bare = await cli(["env", "--lease", grant.lease_id]);
    expect(bare.code).toBe(EXIT_CODES.usage);
    expect(bare.stdout + bare.stderr).not.toContain(grant.password);
    expect(bare.stderr).toContain("it prints only with --json");
    expect((await cli(["env", "--json"])).code).toBe(EXIT_CODES.usage);
    expect((await cli(["return", grant.lease_id])).code).toBe(0);
    expect((await cli(["env", "--lease", grant.lease_id, "--json"])).code).toBe(EXIT_CODES.leaseMismatch);
  });
});

describe("run --lease", () => {
  it("gives the password to the child's environment and to nothing else", async () => {
    await seed({ "23": 2 });
    const grant = await lease("23");
    const envFile = join(home, "child-env.txt");
    const dump = 'require("node:fs").writeFileSync(process.argv[1], Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join("\\n"))';
    const r = await cli(["--verbose", "run", "--lease", grant.lease_id, "--", process.execPath, "-e", dump, envFile], { ARASHOUSE_DEBUG: "1" });
    expect(r.code, r.stderr).toBe(0);
    const childEnv = Object.fromEntries(
      (await readFile(envFile, "utf8"))
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(childEnv).toMatchObject({
      ARAS_URL: "http://127.0.0.1/ah-23-01",
      ARAS_DATABASE: "arashouse_23_01",
      ARAS_USER: "root",
      ARAS_PASSWORD: grant.password,
      ARASHOUSE_SLOT: "23-01",
      ARASHOUSE_FLAVOR: "23",
      ARAS_PKG_ENGINE: "14.0.7",
    });

    // Everything else the binary can show, in its verbose and debug forms.
    await cli(["--verbose", "status"], { ARASHOUSE_DEBUG: "1" });
    await cli(["status", "--json"]);
    await cli(["--verbose", "flavors"]);
    await cli(["flavors", "--json"]);
    await cli(["get", "23", "--holder", "task-b", "--verbose"]);
    await cli(["run", "--lease", grant.lease_id, "--", process.execPath, "-e", "process.exit(3)"]);
    await cli(["return", "23-01", "--if-lease-id", "0".repeat(32)], { ARASHOUSE_DEBUG: "1" });
    await cli(["--verbose", "return", grant.lease_id]);
    await cli(["run", "--lease", grant.lease_id, "--", process.execPath, "-e", "0"], { ARASHOUSE_DEBUG: "1" });
    // printed[0] is the get --json that is allowed to show it, once.
    expect(printed[0]).toContain(grant.password);
    for (const text of printed.slice(1)) expect(text).not.toContain(grant.password);
    expect(await readFile(join(home, "state.json"), "utf8")).not.toContain(grant.password);
    expect(await readFile(join(home, "events.log"), "utf8")).not.toContain(grant.password);
  });

  it("keeps the password in a 0600 lease file that return deletes", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    const file = join(home, "leases", grant.lease_id);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "leases")).mode & 0o777).toBe(0o700);
    }
    expect((await cli(["return", grant.lease_id])).code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(await readdir(join(home, "leases"))).toEqual([]);
  });

  it("passes the command's exit code through, and 127 when it cannot start", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    expect((await cli(["run", "--lease", grant.lease_id, "--", process.execPath, "-e", "process.exit(9)"])).code).toBe(9);
    expect((await cli(["run", "--lease", grant.lease_id, "--", process.execPath, "-e", "process.exit(0)"])).code).toBe(0);
    const missing = await cli(["run", "--lease", grant.lease_id, "--", "no-such-command-arashouse"]);
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain("cannot run");
  });

  it.skipIf(process.platform !== "win32")("on Windows refuses a batch script before it starts anything, with how to run it", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "shim-tool.cmd"), "@echo off\r\nexit /b 0\r\n");
    const r = await cli(["run", "--lease", grant.lease_id, "--", "shim-tool"], { PATH: `${bin};${process.env.PATH ?? ""}` });
    expect(r.code).toBe(EXIT_CODES.usage);
    expect(r.stderr).toMatch(/"shim-tool" is a batch script .*shim-tool\.cmd.*cmd\.exe/);
    expect((await cli(["run", "--lease", grant.lease_id, "--", join(bin, "shim-tool.cmd")])).code).toBe(EXIT_CODES.usage);
  });

  it("refuses a lease that is not leased, and one whose password is gone, with exit 4", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    await rm(join(home, "leases", grant.lease_id));
    const gone = await cli(["run", "--lease", grant.lease_id, "--", "true"]);
    expect(gone.code).toBe(EXIT_CODES.leaseMismatch);
    expect(gone.stderr).toMatch(/take a new one/);

    expect((await cli(["return", grant.lease_id])).code).toBe(0);
    const returned = await cli(["run", "--lease", grant.lease_id, "--", "true"]);
    expect(returned.code).toBe(EXIT_CODES.leaseMismatch);
    expect((await cli(["run", "--lease", "f".repeat(32), "--", "true"])).code).toBe(EXIT_CODES.leaseMismatch);
  });

  it("is a usage error without a lease, without a command, or with a malformed lease id", async () => {
    expect((await cli(["run", "--", "true"])).code).toBe(EXIT_CODES.usage);
    expect((await cli(["run", "--lease", "f".repeat(32)])).code).toBe(EXIT_CODES.usage);
    expect((await cli(["run", "--lease", "f".repeat(32), "--"])).code).toBe(EXIT_CODES.usage);
    expect((await cli(["run", "--lease", "nope", "--", "true"])).code).toBe(EXIT_CODES.usage);
  });
});

describe("extract (ticket 43)", () => {
  /** The fake host's slot folder, where a test puts the files a leaseholder would have changed. */
  const slotFolder = (flavor: string, nn: string) => join(home, "fake-host", "slots", flavor, nn);
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const rowOf = async (slot: string) => {
    const r = await cli(["status", "--json"]);
    const report = JSON.parse(r.stdout) as { slots: { slot: string; extracted: boolean | null }[] };
    const validate = await validator("status.schema.json");
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    return report.slots.find((row) => row.slot === slot);
  };

  it("code copies a changed file and a folder out of the leased slot, and status shows the lease extracted", async () => {
    await seed({ "12sp9": 2 });
    const grant = await lease("12sp9");
    const client = join(slotFolder("12sp9", "01"), "Innovator", "Client", "javascript");
    await put(join(client, "changed.js"), "// the leaseholder's change\n");
    await put(join(client, "sub", "b.js"), "b\n");
    expect(await rowOf("12sp9-01")).toMatchObject({ extracted: false });
    expect(await rowOf("12sp9-02")).toMatchObject({ extracted: null });

    const out = join(home, "out");
    const file = await cli(["extract", "code", "--lease", grant.lease_id, "Innovator/Client/javascript/changed.js", "--to", out]);
    expect(file.code, file.stderr).toBe(0);
    expect(file.stdout).toContain(`extracted 1 file (0.0 MB) from 12sp9-01:Innovator/Client/javascript/changed.js to ${join(out, "changed.js")}`);
    expect(await readFile(join(out, "changed.js"), "utf8")).toBe("// the leaseholder's change\n");
    const folder = await cli(["extract", "code", "--lease", grant.lease_id, "Innovator\\Client\\javascript", "--to", out]);
    expect(folder.code, folder.stderr).toBe(0);
    expect(await readFile(join(out, "javascript", "sub", "b.js"), "utf8")).toBe("b\n");
    expect(await readFile(join(out, "javascript", "changed.js"), "utf8")).toBe("// the leaseholder's change\n");
    expect(await rowOf("12sp9-01")).toMatchObject({ extracted: true });
    expect(await readFile(join(home, "events.log"), "utf8")).toContain('"event":"lease-extracted"');

    // It never replaces what is there.
    const again = await cli(["extract", "code", "--lease", grant.lease_id, "Innovator/Client/javascript/changed.js", "--to", out]);
    expect(again.code).toBe(EXIT_CODES.refused);
    expect(again.stderr).toContain("extract never replaces a file");

    // The flag goes with the lease: after the return and the next lease, it is false again.
    const back = await cli(["return", grant.lease_id]);
    expect(back.code).toBe(0);
    expect((await rowOf("12sp9-01"))?.extracted).toBeNull();
  });

  it("code refuses a path outside the slot, a link, and the slot's config and key files without --allow-config", async () => {
    await seed({ "12sp9": 1 });
    const grant = await lease("12sp9");
    const slot = slotFolder("12sp9", "01");
    await put(join(slot, "InnovatorServerConfig.xml"), "<Innovator/>");
    await put(join(slot, "OAuthServer", "App_Data", "key-1.xml"), "<key/>");
    await put(join(slot, "OAuthServer", "App_Data", "readme.txt"), "x");
    await put(join(slot, "Innovator", "Client", "x.js"), "x");
    await symlink(join(slot, "OAuthServer"), join(slot, "Innovator", "Client", "link"));
    const out = join(home, "out");
    const code = (path: string, ...extra: string[]) => cli(["extract", "code", "--lease", grant.lease_id, path, "--to", out, ...extra]);

    for (const path of ["../../23/01", "Innovator/../..", "/etc/passwd", "C:\\Windows", "Innovator/Client"]) {
      const r = await code(path);
      expect(r.code, `${path}: ${r.stderr}`).toBe(EXIT_CODES.refused);
    }
    expect((await code("Innovator/Client/link")).stderr).toContain("is a link or junction");
    const config = await code("InnovatorServerConfig.xml");
    expect(config.code).toBe(EXIT_CODES.refused);
    expect(config.stderr).toContain("--allow-config");
    const keys = await code("OAuthServer");
    expect(keys.code).toBe(EXIT_CODES.refused);
    expect(keys.stderr).toContain("OAuthServer/App_Data/key-1.xml");
    expect(existsSync(out)).toBe(false);
    expect((await code("OAuthServer/App_Data/readme.txt")).code).toBe(0);
    const allowed = await code("OAuthServer", "--allow-config");
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(await readFile(join(out, "OAuthServer", "App_Data", "key-1.xml"), "utf8")).toBe("<key/>");
    expect(allowed.stderr).toContain("hold the slot's secrets");

    expect((await code("Innovator/Client/missing.js")).code).toBe(1);
    expect((await cli(["extract", "code", "--lease", "f".repeat(32), "Innovator", "--to", out])).code).toBe(EXIT_CODES.leaseMismatch);
    expect((await cli(["extract", "code", "--lease", grant.lease_id, "--to", out])).code).toBe(EXIT_CODES.usage);
    expect((await cli(["extract", "code", "--lease", grant.lease_id, "Innovator"])).code).toBe(EXIT_CODES.usage);
    expect((await cli(["extract", "code", "Innovator", "--to", out])).code).toBe(EXIT_CODES.usage);
    expect((await cli(["extract", "logs", "--lease", grant.lease_id])).code).toBe(EXIT_CODES.usage);
  });

  it("db stages a backup of the leased slot's database in its staging folder, copies it out and deletes the staged copy", async () => {
    await seed({ "12sp9": 1 });
    const grant = await lease("12sp9");
    const dest = join(home, "kept", "db.bak");
    await mkdir(dirname(dest));
    const r = await cli(["extract", "db", "--lease", grant.lease_id, "--to", dest]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`extracted the database of 12sp9-01 (COPY_ONLY backup, 0.0 MB) to ${dest}`);
    expect(await readFile(dest, "utf8")).toBe("fake COPY_ONLY backup of arashouse_12sp9_01\n");
    expect(existsSync(join(home, "fake-host", "staging", grant.lease_id))).toBe(false);
    expect(await readdir(join(home, "kept"))).toEqual(["db.bak"]);
    expect(await rowOf("12sp9-01")).toMatchObject({ extracted: true });

    expect((await cli(["extract", "db", "--lease", grant.lease_id, "--to", dest])).code).toBe(EXIT_CODES.refused);
    expect((await cli(["extract", "db", "--lease", grant.lease_id, "--to", join(home, "no-such-folder", "db.bak")])).code).toBe(EXIT_CODES.usage);
    const unreachable = await cli(["extract", "db", "--lease", grant.lease_id, "--to", join(home, "kept", "two.bak")], {
      ARASHOUSE_FAKE_FAULTS: JSON.stringify([{ method: "backupDatabase", kind: "fail", error: "Unreachable" }]),
    });
    expect(unreachable.code).toBe(EXIT_CODES.hostUnreachable);
    expect(existsSync(join(home, "fake-host", "staging", grant.lease_id))).toBe(false);
    expect((await cli(["return", grant.lease_id])).code).toBe(0);
    expect((await cli(["extract", "db", "--lease", grant.lease_id, "--to", join(home, "kept", "three.bak")])).code).toBe(EXIT_CODES.leaseMismatch);
  });

  it("return reminds on stderr that the slot's state is discarded, once; --quiet leaves it out", async () => {
    await seed({ "23": 2 });
    const first = await lease("23");
    const second = await lease("23", "task-b");
    const r = await cli(["return", first.lease_id]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("Returning slot 23-01. Its state will be discarded; anything you want to keep must already be out.\n");
    expect(r.stdout).not.toContain("Returning");
    const again = await cli(["return", first.lease_id]);
    expect(again.stderr).toBe("");
    const quiet = await cli(["return", "23-02", "--if-lease-id", second.lease_id, "--quiet"]);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");
    expect(quiet.stdout).toContain("returned 23-02");
  });
});

describe("get --bootstrap and bootstrap --lease (ticket 42)", () => {
  const FAKE_APKG = join(repoRoot, "test", "fixtures", "fake-aras-pkg.mjs");

  interface Step {
    name: string;
    status: string;
    ok: boolean;
    ms: number;
    log: string | null;
    detail: string;
  }
  type Booted = Grant & { bootstrap: { recipe: string; steps: Step[]; code?: { ok: boolean }[]; git?: { ok: boolean; commit: string } }; imports?: { exit_code: number }[] };

  /**
   * A recipe folder with what a recipe names: a backup, a one-file client overlay, a package manifest (`exit` is what the
   * fake aras-pkg exits with), and the slots' `Innovator\` trees under the install root the CLI stages into.
   */
  async function workspace(flavor: FlavorKey, slots = 1, exit = 0): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
    const dir = join(home, "work");
    await mkdir(join(dir, "overlay", "scripts"), { recursive: true });
    await writeFile(join(dir, "overlay", "scripts", "fix.js"), "// fixed");
    await mkdir(join(dir, "profiles"), { recursive: true });
    await writeFile(join(dir, "profiles", "demo.bak"), "not really a backup");
    await mkdir(join(dir, "pkgs"), { recursive: true });
    await writeFile(join(dir, "pkgs", "imports.mf"), `exit=${exit}\n<imports><package name="LIBSJS-SCRATCH-r" path="r\\Import" /></imports>\n`);
    const root = join(home, "root");
    for (let n = 1; n <= slots; n++) {
      const tree = join(root, "slots", flavor, `0${n}`, "Innovator");
      await mkdir(join(tree, "Client", "scripts"), { recursive: true });
      await writeFile(join(tree, "Client", "scripts", "app.js"), "// app");
    }
    await mkdir(join(root, "staging"), { recursive: true });
    return { dir, env: { ARASHOUSE_LOCAL_ROOT: root, ARASHOUSE_APKG: FAKE_APKG, FAKE_APKG_RECORD: join(home, "apkg-runs.jsonl") } };
  }

  /** Everything the ticket names: a restore, code, an import, and the git baseline. */
  function fullRecipe(flavor: FlavorKey, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      flavor,
      restore: "profiles/demo.bak",
      code: [{ from: "./overlay", to: "Innovator/Client" }],
      import: [{ manifest: "./pkgs/imports.mf", merge: true, release: "R1" }],
      git: true,
      ...extra,
    };
  }

  async function writeRecipe(dir: string, recipe: unknown, name = "recipe.json"): Promise<string> {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(recipe));
    return path;
  }

  async function slotOf(id: string) {
    return (await new StateStore({ home }).read()).slots[id];
  }

  async function apkgRuns(): Promise<number> {
    const file = join(home, "apkg-runs.jsonl");
    return existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").length : 0;
  }

  const statuses = (steps: readonly Step[]) => steps.map((s) => `${s.name}:${s.status}`);

  for (const flavor of ["12sp9", "23", "35"] as const) {
    it(`brings a ${flavor} lease up with all three sections and git, in order, and reports each step`, async () => {
      await seed({ [flavor]: 1 });
      const { dir, env } = await workspace(flavor);
      const recipe = await writeRecipe(dir, fullRecipe(flavor));
      // The flavor comes from the recipe.
      const r = await cli(["get", "--bootstrap", recipe, "--holder", "boot", "--json"], env);
      expect(r.code, r.stderr).toBe(0);
      const grant = JSON.parse(r.stdout) as Booted;
      const validate = await validator("get.schema.json");
      expect(validate(grant), JSON.stringify(validate.errors)).toBe(true);
      expect(grant.bootstrap.recipe).toBe(recipe);
      expect(statuses(grant.bootstrap.steps)).toEqual(["restore:ok", "code:ok", "import:ok", "git:ok", "health:ok"]);
      expect(grant.bootstrap.code).toEqual([expect.objectContaining({ source: "./overlay", subpath: "Innovator/Client", ok: true })]);
      expect(grant.imports?.map((i) => i.exit_code)).toEqual([0]);
      const logs = join(home, "logs");
      expect(grant.bootstrap.steps.find((s) => s.name === "import")?.log).toBe(join(logs, `${grant.lease_id}-import-1.log`));
      expect(grant.bootstrap.steps.find((s) => s.name === "health")?.log).toBe(join(logs, `${grant.lease_id}-bootstrap.log`));
      expect((await slotOf(`${flavor}-01`))?.lease?.bootstrap).toMatchObject({ restore: "custom", code_deploys: 1, imports: 1, git: grant.bootstrap.git?.commit });
      // The bootstrap log has one line per step that ran, and no log, the state or stderr holds the password.
      const log = await readFile(join(logs, `${grant.lease_id}-bootstrap.log`), "utf8");
      expect(log).toMatch(/ restore ok in \d+ ms: /);
      expect(log).toMatch(/ health ok in \d+ ms: /);
      for (const name of await readdir(logs)) expect(await readFile(join(logs, name), "utf8")).not.toContain(grant.password);
      if (process.platform !== "win32") expect(statSync(join(logs, `${grant.lease_id}-bootstrap.log`)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(home, "state.json"), "utf8")).not.toContain(grant.password);
      expect(r.stderr).not.toContain(grant.password);
    });
  }

  it("skips the steps a recipe leaves out, reads @name from the recipes folder, and prints the steps without --json", async () => {
    await seed({ "23": 1 });
    await writeRecipe(join(home, "recipes"), { flavor: "23" }, "plain.json");
    const r = await cli(["get", "23", "--bootstrap", "@plain", "--holder", "boot"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`recipe:    ${join(home, "recipes", "plain.json")}`);
    expect(r.stdout).toMatch(/^restore: +skipped \(not in the recipe\)$/m);
    expect(r.stdout).toMatch(/^health: +ok in \d+\.\d s \(/m);
    expect(r.stdout).toContain("password:  not shown");
    expect((await cli(["get", "--bootstrap", "@nope", "--holder", "boot"])).code).toBe(EXIT_CODES.usage);
    expect((await cli(["get", "--bootstrap", "@../x", "--holder", "boot"])).code).toBe(EXIT_CODES.usage);
  });

  it("fails a bad recipe before any slot is reserved: a bad path, a password key, a flavor mismatch, an option beside it", async () => {
    await seed({ "12sp9": 1 });
    const { dir, env } = await workspace("12sp9");
    const planted = "hunter2-in-a-recipe";
    const cases: [unknown, number, RegExp][] = [
      [fullRecipe("12sp9", { restore: "profiles/absent.bak" }), EXIT_CODES.usage, /is not a file/],
      [fullRecipe("12sp9", { code: [{ from: "./nowhere" }] }), EXIT_CODES.refused, /does not exist/],
      [fullRecipe("12sp9", { code: [{ from: "./overlay", to: "../x" }] }), EXIT_CODES.refused, /\.\./],
      [fullRecipe("12sp9", { import: [{ manifest: "./pkgs/absent.mf" }] }), EXIT_CODES.usage, /does not exist/],
      [fullRecipe("12sp9", { import: [{ manifest: "./pkgs/imports.mf", languages: "*" }] }), EXIT_CODES.usage, /engine 14\.35 only/],
      [{ ...fullRecipe("12sp9"), password: planted }, EXIT_CODES.usage, /password looks like a secret/],
      [fullRecipe("23"), EXIT_CODES.usage, /is for flavor 23, not 12sp9/],
    ];
    for (const [recipe, code, message] of cases) {
      const path = await writeRecipe(dir, recipe);
      const r = await cli(["get", "12sp9", "--bootstrap", path, "--holder", "boot", "--json"], env);
      expect(r.code, JSON.stringify(recipe)).toBe(code);
      expect(r.stderr, JSON.stringify(recipe)).toMatch(message);
      expect(r.stdout).toBe("");
      expect(r.stderr).not.toContain(planted);
    }
    await writeFile(join(dir, "broken.json"), "{ not json");
    expect((await cli(["get", "12sp9", "--bootstrap", join(dir, "broken.json"), "--holder", "boot"], env)).stderr).toMatch(/not JSON/);
    const recipe = await writeRecipe(dir, { flavor: "12sp9" });
    for (const extra of [["--code", join(dir, "overlay")], ["--git"], ["--agent"], ["--atomic"], ["--restore", "demo"], ["--import", join(dir, "pkgs", "imports.mf")]]) {
      const r = await cli(["get", "12sp9", "--bootstrap", recipe, "--holder", "boot", ...extra], env);
      expect(r.code, extra[0]).toBe(EXIT_CODES.usage);
      expect(r.stderr, extra[0]).toMatch(/goes in the recipe, not beside --bootstrap/);
    }
    expect((await cli(["get", "--bootstrap", await writeRecipe(dir, {}), "--holder", "boot"], env)).stderr).toMatch(/names no flavor/);
    expect((await slotOf("12sp9-01"))?.status).toBe("free");
    expect(await apkgRuns()).toBe(0);
  });

  it("returns the lease when a step fails (exit 9), names the step and its log, and runs nothing after it", async () => {
    await seed({ "12sp9": 1 });
    const { dir, env } = await workspace("12sp9");
    const recipe = await writeRecipe(dir, fullRecipe("12sp9"));
    const faults = { ARASHOUSE_FAKE_FAULTS: JSON.stringify([{ method: "deployCode", kind: "fail", error: "Retryable", message: "robocopy failed (16)" }]) };
    const r = await cli(["get", "12sp9", "--bootstrap", recipe, "--holder", "boot", "--json"], { ...env, ...faults });
    expect(r.code).toBe(EXIT_CODES.bootstrapFailed);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/the bootstrap's code step failed \(the deploy of \.\/overlay failed: robocopy failed \(16\)\); its log: .*-bootstrap\.log; the lease of 12sp9-01 was returned, and the slot is reset \(--keep-on-fail keeps it\)/);
    expect(r.stderr).toMatch(/^arashouse: restore: +ok in /m);
    expect(r.stderr).toMatch(/^arashouse: import: +skipped \(not reached: the code step failed\)$/m);
    expect(r.stderr).toMatch(/^arashouse: health: +skipped \(not reached: the code step failed\)$/m);
    expect(r.stderr).toContain("hint: read the log named above");
    expect(await apkgRuns()).toBe(0);
    expect((await slotOf("12sp9-01"))?.status).toBe("dirty");
    expect(await readdir(join(home, "leases"))).toEqual([]);
  });

  it("--keep-on-fail and \"atomic\": false keep the lease and print it with the failed step, still exit 9", async () => {
    await seed({ "23": 2 });
    const { dir, env } = await workspace("23", 2, 2);
    const recipe = await writeRecipe(dir, fullRecipe("23"));
    const kept = await cli(["get", "--bootstrap", recipe, "--holder", "boot", "--json", "--keep-on-fail"], env);
    expect(kept.code).toBe(EXIT_CODES.bootstrapFailed);
    const grant = JSON.parse(kept.stdout) as Booted;
    const validate = await validator("get.schema.json");
    expect(validate(grant), JSON.stringify(validate.errors)).toBe(true);
    expect(statuses(grant.bootstrap.steps)).toEqual(["restore:ok", "code:ok", "import:failed", "git:skipped", "health:skipped"]);
    expect(grant.bootstrap.steps[2]).toMatchObject({ ok: false, log: join(home, "logs", `${grant.lease_id}-import-1.log`), detail: expect.stringMatching(/aras-pkg exit 2/) });
    expect(kept.stderr).toContain(`is kept (--keep-on-fail): return it with: arashouse return ${grant.lease_id}`);
    // The import's log is named once: its detail already carries it.
    expect(kept.stderr.split(`${grant.lease_id}-import-1.log); its log`)).toHaveLength(1);
    expect((await slotOf(grant.slot))?.status).toBe("leased");

    // The health check, kept by the recipe itself.
    const healthy = await writeRecipe(dir, { flavor: "23", atomic: false });
    const down = await cli(["get", "--bootstrap", healthy, "--holder", "boot", "--json"], { ...env, ARASHOUSE_FAKE_PROBE: "down" });
    expect(down.code).toBe(EXIT_CODES.bootstrapFailed);
    const second = JSON.parse(down.stdout) as Booted;
    expect(statuses(second.bootstrap.steps)).toEqual(["restore:skipped", "code:skipped", "import:skipped", "git:skipped", "health:failed"]);
    // The steps before the one that failed were not in the recipe; none was "not reached".
    expect(second.bootstrap.steps.slice(0, 4).map((s) => s.detail)).toEqual(Array(4).fill("not in the recipe"));
    expect((await slotOf(second.slot))?.status).toBe("leased");
  });

  it("a failed health check returns the lease by default", async () => {
    await seed({ "35": 1 });
    const { dir, env } = await workspace("35");
    const recipe = await writeRecipe(dir, { flavor: "35" });
    const r = await cli(["get", "--bootstrap", recipe, "--holder", "boot"], { ...env, ARASHOUSE_FAKE_PROBE: "down" });
    expect(r.code).toBe(EXIT_CODES.bootstrapFailed);
    expect(r.stderr).toMatch(/the bootstrap's health step failed \(Client\/: connection failed \(ECONNREFUSED\)\)/);
    expect((await slotOf("35-01"))?.status).toBe("dirty");
  });

  it("a failed restore returns the lease even with --keep-on-fail", async () => {
    await seed({ "12sp9": 1 });
    const { dir, env } = await workspace("12sp9");
    const recipe = await writeRecipe(dir, fullRecipe("12sp9"));
    const faults = { ARASHOUSE_FAKE_FAULTS: JSON.stringify([{ method: "restoreDatabase", kind: "fail", error: "Retryable", message: "RESTORE DATABASE failed" }]) };
    const r = await cli(["get", "--bootstrap", recipe, "--holder", "boot", "--json", "--keep-on-fail"], { ...env, ...faults });
    expect(r.code).toBe(EXIT_CODES.bootstrapFailed);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/the bootstrap's restore step failed \(.*RESTORE DATABASE failed.*\); its log: .*-bootstrap\.log; the lease of 12sp9-01 was returned/);
    expect(r.stderr).toMatch(/^arashouse: code: +skipped \(not reached: the restore step failed\)$/m);
    expect((await slotOf("12sp9-01"))?.status).toBe("dirty");
    // The staged backup is gone.
    expect(existsSync(join(home, "fake-staging")) ? await readdir(join(home, "fake-staging")) : []).toEqual([]);
  });

  it("bootstrap --lease applies a recipe to a held lease, and a restore over its imports needs --yes", async () => {
    await seed({ "23": 1 });
    const { dir, env } = await workspace("23");
    const grant = await lease("23");
    const first = await writeRecipe(dir, { code: [{ from: "./overlay", to: "Innovator/Client" }], import: [{ manifest: "./pkgs" }], git: true });
    const r = await cli(["bootstrap", "--lease", grant.lease_id, first, "--json"], env);
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as { slot: string; bootstrap: { steps: Step[] } };
    const validate = await validator("bootstrap.schema.json");
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.slot).toBe("23-01");
    expect(statuses(report.bootstrap.steps)).toEqual(["restore:skipped", "code:ok", "import:ok", "git:ok", "health:ok"]);
    expect((await slotOf("23-01"))?.lease?.bootstrap).toMatchObject({ imports: 1, code_deploys: 1 });

    // Again: the baseline is there, so git is skipped; the restore discards the import, so it needs --yes.
    const again = await writeRecipe(dir, { flavor: "23", restore: "profiles/demo.bak", git: true });
    const refused = await cli(["bootstrap", "--lease", grant.lease_id, again], env);
    expect(refused.code).toBe(EXIT_CODES.usage);
    expect(refused.stderr).toMatch(/discards the 1 import made onto this lease; give --yes/);
    const yes = await cli(["bootstrap", "--lease", grant.lease_id, again, "--yes"], env);
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stderr).toMatch(/the recipe's restore replaces the database of 23-01/);
    expect(yes.stdout).toMatch(/^restore: +ok in /m);
    expect(yes.stdout).toMatch(/^git: +skipped \(the lease already has a git baseline/m);
    expect((await slotOf("23-01"))?.lease?.bootstrap).toMatchObject({ restore: "custom", imports: 0 });
    expect((await slotOf("23-01"))?.status).toBe("leased");

    // A lease that is not held, a recipe for another flavor, and a failed step (the lease is kept).
    expect((await cli(["bootstrap", "--lease", "f".repeat(32), again], env)).code).toBe(EXIT_CODES.leaseMismatch);
    expect((await cli(["bootstrap", "--lease", grant.lease_id, await writeRecipe(dir, { flavor: "35" })], env)).code).toBe(EXIT_CODES.usage);
    const failed = await cli(["bootstrap", "--lease", grant.lease_id, await writeRecipe(dir, {})], { ...env, ARASHOUSE_FAKE_PROBE: "down" });
    expect(failed.code).toBe(EXIT_CODES.bootstrapFailed);
    expect(failed.stderr).toMatch(/the bootstrap's health step failed .*; the lease is kept/);
    expect((await slotOf("23-01"))?.status).toBe("leased");
    expect((await cli(["bootstrap", "--lease", grant.lease_id], env)).code).toBe(EXIT_CODES.usage);
  });
});

describe("get --import and import (ticket 41)", () => {
  const FAKE_APKG = join(repoRoot, "test", "fixtures", "fake-aras-pkg.mjs");

  interface ApkgRun {
    args: string[];
    env: { ARAS_URL: string; ARAS_DATABASE: string; ARAS_USER: string; ARAS_PKG_ENGINE: string; ARAS_PASSWORD_SHA256: string | null };
  }

  /** A manifest in its own folder; `exit` is what the fake aras-pkg exits with when it imports it. */
  async function manifest(name: string, exit = 0): Promise<string> {
    const dir = join(home, "packages", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "imports.mf"), `exit=${exit}\n<imports><package name="LIBSJS-SCRATCH-${name}" path="${name}\\Import" /></imports>\n`);
    return join(dir, "imports.mf");
  }

  function withApkg(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { ARASHOUSE_APKG: FAKE_APKG, FAKE_APKG_RECORD: join(home, "apkg-runs.jsonl"), ...env };
  }

  async function apkgRuns(): Promise<ApkgRun[]> {
    const file = join(home, "apkg-runs.jsonl");
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as ApkgRun);
  }

  async function slotStatus(slot: string): Promise<string> {
    const report = JSON.parse((await cli(["status", "--json"])).stdout) as { slots: { slot: string; status: string }[] };
    return report.slots.find((s) => s.slot === slot)?.status ?? "missing";
  }

  it("imports each manifest in order with the flavor's engine, the password only in the child's environment", async () => {
    await seed({ "23": 1 });
    const first = await manifest("one");
    const second = await manifest("two");
    const r = await cli(["get", "23", "--holder", "boot", "--json", "--import", first, "--merge", "--release", "R1", "--import", join(home, "packages", "two"), "--package", "A", "--package", "B"], withApkg());
    expect(r.code, r.stderr).toBe(0);
    const grant = JSON.parse(r.stdout) as Grant & { imports: { manifest: string; exit_code: number; log: string }[] };
    const validate = await validator("get.schema.json");
    expect(validate(grant), JSON.stringify(validate.errors)).toBe(true);
    const logs = join(home, "logs");
    expect(grant.imports).toEqual([
      { manifest: first, exit_code: 0, log: join(logs, `${grant.lease_id}-import-1.log`) },
      { manifest: second, exit_code: 0, log: join(logs, `${grant.lease_id}-import-2.log`) },
    ]);
    if (process.platform !== "win32") expect(statSync(logs).mode & 0o777).toBe(0o700);

    const runs = await apkgRuns();
    const connection = ["--url", "http://127.0.0.1/ah-23-01", "--database", "arashouse_23_01", "--user", "root"];
    expect(runs.map((x) => x.args)).toEqual([
      ["import", first, ...connection, "--log", grant.imports[0]!.log, "--engine", "14.0.7", "--merge", "--release", "R1"],
      ["import", second, ...connection, "--log", grant.imports[1]!.log, "--engine", "14.0.7", "--package", "A", "--package", "B"],
    ]);
    const hash = createHash("sha256").update(grant.password).digest("hex");
    for (const run of runs) {
      expect(run.env).toEqual({ ARAS_URL: "http://127.0.0.1/ah-23-01", ARAS_DATABASE: "arashouse_23_01", ARAS_USER: "root", ARAS_PKG_ENGINE: "14.0.7", ARAS_PASSWORD_SHA256: hash });
      expect(run.args.join(" ")).not.toContain(grant.password);
    }
    expect(r.stderr).toContain("[INFO] fake import of");
    expect(r.stderr).toContain(`import 2 of 2 (${join(home, "packages", "two")}, engine 14.0.7) done`);

    // The password is in the JSON, once, and nowhere else: not in the logs, the state, the events or stderr.
    expect(r.stderr).not.toContain(grant.password);
    for (const name of await readdir(logs)) expect(await readFile(join(logs, name), "utf8")).not.toContain(grant.password);
    expect(await readFile(join(home, "state.json"), "utf8")).not.toContain(grant.password);
    expect(await readFile(join(home, "events.log"), "utf8")).not.toContain(grant.password);
  });

  it("a failed import returns the lease and exits 9 with aras-pkg's exit code and log; later imports do not run", async () => {
    await seed({ "12sp9": 1 });
    const bad = await manifest("bad", 2);
    const after = await manifest("after");
    const r = await cli(["get", "12sp9", "--holder", "boot", "--json", "--import", bad, "--import", after], withApkg());
    expect(r.code).toBe(EXIT_CODES.importFailed);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/import 1 of 2 \(.*bad.*, engine 12\.0\) failed: aras-pkg exit 2; its log: .*-import-1\.log; the lease of 12sp9-01 was returned/);
    expect(r.stderr).toContain("hint: read the log named above");
    expect((await apkgRuns()).length).toBe(1);
    expect(await slotStatus("12sp9-01")).toBe("dirty");
    expect(await readdir(join(home, "leases"))).toEqual([]);
  });

  it("--keep-on-fail keeps the lease, prints it, and still exits 9", async () => {
    await seed({ "12sp9": 1 });
    const bad = await manifest("bad", 1);
    const r = await cli(["get", "12sp9", "--holder", "boot", "--json", "--import", bad, "--keep-on-fail"], withApkg());
    expect(r.code).toBe(EXIT_CODES.importFailed);
    const grant = JSON.parse(r.stdout) as Grant & { imports: { exit_code: number }[] };
    expect(grant.imports.map((i) => i.exit_code)).toEqual([1]);
    expect(r.stderr).toContain(`the lease of 12sp9-01 is kept (--keep-on-fail): return it with: arashouse return ${grant.lease_id}`);
    expect(await slotStatus("12sp9-01")).toBe("leased");
  });

  it("refuses, before a lease is taken, what libs-js would refuse or what would run the wrong engine", async () => {
    await seed({ "12sp9": 1, "23": 1 });
    const ok = await manifest("ok");
    for (const [flavor, extra, env] of [
      ["12sp9", ["--languages", "en"], {}],
      ["23", ["--languages", "*"], {}],
      ["23", ["--collect-errors"], {}],
      ["23", ["--batch"], {}],
      ["23", ["--skip-version-check"], {}],
      ["23", ["--engine", "13.0"], {}],
      ["23", ["--merge", "--no-merge"], {}],
      ["23", ["--timeout", "soon"], {}],
      ["23", [], { ARAS_PKG_ENGINE: "14.35" }],
      ["12sp9", [], { ARAS_PKG_ENGINE: "14.0.7" }],
    ] as const) {
      const r = await cli(["get", flavor, "--holder", "boot", "--import", ok, ...extra], withApkg(env));
      expect(r.code, `${flavor} ${extra.join(" ")} ${JSON.stringify(env)}: ${r.stderr}`).toBe(EXIT_CODES.usage);
    }
    for (const args of [
      ["get", "23", "--holder", "boot", "--merge", "--import", ok],
      ["get", "23", "--holder", "boot", "--keep-on-fail"],
      ["get", "23", "--holder", "boot", "--import", join(home, "nope", "imports.mf")],
      ["get", "23", "--holder", "boot", "--import", home],
      ["get", "23", "--holder", "boot", "--import"],
    ]) {
      expect((await cli(args, withApkg())).code, args.join(" ")).toBe(EXIT_CODES.usage);
    }
    expect(await apkgRuns()).toEqual([]);
    expect(await slotStatus("23-01")).toBe("free");
    expect(await slotStatus("12sp9-01")).toBe("free");
  });

  it("runs another engine only when the import names it, and passes the 14.35 options on a 35 lease", async () => {
    await seed({ "23": 1, "35": 1 });
    const ok = await manifest("ok");
    const named = await cli(["get", "23", "--holder", "boot", "--import", ok, "--engine", "14.35", "--skip-version-check"], withApkg({ ARAS_PKG_ENGINE: "14.35" }));
    expect(named.code, named.stderr).toBe(0);
    const matching = await cli(["get", "35", "--holder", "boot", "--import", ok, "--languages", "en,de", "--collect-errors", "--batch", "--timeout", "-1"], withApkg({ ARAS_PKG_ENGINE: "14.35" }));
    expect(matching.code, matching.stderr).toBe(0);
    const runs = await apkgRuns();
    expect(runs[0]!.args.slice(runs[0]!.args.indexOf("--engine"))).toEqual(["--engine", "14.35", "--skip-version-check"]);
    expect(runs[1]!.args.slice(runs[1]!.args.indexOf("--engine"))).toEqual(["--engine", "14.35", "--languages", "en,de", "--collect-errors", "--batch", "--timeout=-1"]);
  });

  it("import --lease imports onto a held lease, numbers its logs after the earlier ones, and keeps the lease when one fails", async () => {
    await seed({ "23": 1 });
    const ok = await manifest("ok");
    const bad = await manifest("bad", 1);
    const got = await cli(["get", "23", "--holder", "boot", "--json", "--import", ok], withApkg());
    expect(got.code, got.stderr).toBe(0);
    const grant = JSON.parse(got.stdout) as Grant;
    const more = await cli(["import", "--lease", grant.lease_id, join(home, "packages", "ok"), "--merge", ok], withApkg());
    expect(more.code, more.stderr).toBe(0);
    expect(more.stdout).toContain(`import 2: ${ok} (exit 0; log ${join(home, "logs", `${grant.lease_id}-import-3.log`)})`);
    const failed = await cli(["import", "--lease", grant.lease_id, bad], withApkg());
    expect(failed.code).toBe(EXIT_CODES.importFailed);
    expect(failed.stderr).toMatch(/aras-pkg exit 1; its log: .*-import-4\.log; the lease is kept/);
    expect(await slotStatus("23-01")).toBe("leased");
    for (const run of await apkgRuns()) expect(run.env.ARAS_PASSWORD_SHA256).toBe(createHash("sha256").update(grant.password).digest("hex"));
    for (const text of printed.slice(1)) expect(text).not.toContain(grant.password);

    expect((await cli(["return", grant.lease_id])).code).toBe(0);
    expect((await cli(["import", "--lease", grant.lease_id, ok], withApkg())).code).toBe(EXIT_CODES.leaseMismatch);
    for (const args of [["import", ok], ["import", "--lease", grant.lease_id], ["import", "--lease", "nope", ok], ["import", "--lease", grant.lease_id, "--merge", ok]]) {
      expect((await cli(args, withApkg())).code, args.join(" ")).toBe(EXIT_CODES.usage);
    }
  });

  it("needs aras-pkg before it takes a lease, and doctor says where it comes from", async () => {
    await seed({ "23": 1 });
    const ok = await manifest("ok");
    const none = await cli(["get", "23", "--holder", "boot", "--import", ok], { PATH: "/nonexistent" });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("aras-pkg (import-export-libs-js) is not on PATH");
    expect(await slotStatus("23-01")).toBe("free");
    expect((await cli(["get", "23", "--holder", "boot", "--import", ok], { ARASHOUSE_APKG: join(home, "missing.js") })).code).toBe(1);

    const found = await cli(["doctor"], withApkg());
    expect(found.code, found.stdout).toBe(0);
    expect(found.stdout).toContain(`ok    aras-pkg: ${FAKE_APKG} (from ARASHOUSE_APKG), version 9.9.9-fake`);
    const missing = await cli(["doctor"], { PATH: "/nonexistent" });
    expect(missing.code, missing.stdout).toBe(0);
    expect(missing.stdout).toContain("warn  aras-pkg: not on PATH");
  });
});

describe("exit codes", () => {
  it("0 for get, status, return and a repeated return", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    expect((await cli(["status"])).code).toBe(0);
    const first = await cli(["return", "23-01", "--if-lease-id", grant.lease_id]);
    expect(first.code).toBe(0);
    const again = await cli(["return", grant.lease_id]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already returned");
  });

  it("2 for usage errors", async () => {
    await seed({ "23": 1 });
    for (const args of [
      [],
      ["bogus"],
      ["help", "bogus"],
      ["get"],
      ["get", "99", "--holder", "x"],
      ["get", "23"],
      ["get", "23", "--holder", "x", "--wait", "soon"],
      ["get", "23", "--holder", "x", "--frobnicate"],
      ["return"],
      ["return", "23-01"],
      ["status", "extra"],
      ["media"],
    ]) {
      const r = await cli(args);
      expect(r.code, args.join(" ")).toBe(EXIT_CODES.usage);
    }
  });

  it("3 when no slot is free", async () => {
    await seed({ "23": 1 });
    await lease("23");
    const r = await cli(["get", "23", "--holder", "task-b"]);
    expect(r.code).toBe(EXIT_CODES.noSlot);
    expect(r.stderr).toContain("no 23 slot is free: 1 slot, 1 leased, 0 resetting, 0 quarantined");
    expect((await cli(["get", "35", "--holder", "task-b", "--wait", "0"])).code).toBe(EXIT_CODES.noSlot);
  });

  it("4 when return names a lease the slot no longer holds", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    const r = await cli(["return", "23-01", "--if-lease-id", "0".repeat(32)]);
    expect(r.code).toBe(EXIT_CODES.leaseMismatch);
    expect(JSON.parse((await cli(["status", "--json"])).stdout).slots[0].status).toBe("leased");
    expect((await cli(["return", grant.lease_id])).code).toBe(0);
  });

  it("5 when return --wait sees no reset finish", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    const r = await cli(["return", grant.lease_id, "--wait=0"]);
    expect(r.code).toBe(EXIT_CODES.resetFailed);
  });

  it("6 when the host is unreachable, 7 when a guard refuses", async () => {
    await seed({ "23": 1 });
    const fault = (error: string) => JSON.stringify([{ method: "readStamp", kind: "fail", error }]);
    const unreachable = await cli(["get", "23", "--holder", "x"], { ARASHOUSE_FAKE_FAULTS: fault("Unreachable") });
    expect(unreachable.code).toBe(EXIT_CODES.hostUnreachable);
    const refused = await cli(["get", "23", "--holder", "x"], { ARASHOUSE_FAKE_FAULTS: fault("Refused") });
    expect(refused.code).toBe(EXIT_CODES.refused);
    // No broker on this machine: the default host is unreachable.
    expect((await cli(["get", "23", "--holder", "x"], { ARASHOUSE_HOST: "" })).code).toBe(EXIT_CODES.hostUnreachable);
  });

  it("documents every code of the table in docs/cli.md", async () => {
    const doc = await readFile(join(repoRoot, "docs", "cli.md"), "utf8");
    for (const code of [...Object.values(EXIT_CODES), 1, SECRET_REQUIRED_EXIT_CODE, 127]) {
      expect(doc, `exit code ${code}`).toMatch(new RegExp(`^\\| ${code} \\|`, "m"));
    }
  });
});

describe("errors", () => {
  it("are one line and a hint, with the stack only under ARASHOUSE_DEBUG=1", async () => {
    await seed({ "23": 1 });
    const env = { ARASHOUSE_FAKE_FAULTS: JSON.stringify([{ method: "readStamp", kind: "fail", error: "Unreachable" }]) };
    const plain = await cli(["get", "23", "--holder", "x"], env);
    const lines = plain.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^arashouse: /);
    expect(lines[1]).toMatch(/^hint: /);
    expect(plain.stderr).not.toMatch(/\n\s+at /);
    const debug = await cli(["get", "23", "--holder", "x"], { ...env, ARASHOUSE_DEBUG: "1" });
    expect(debug.stderr).toMatch(/\n\s+at /);
  });
});

describe("flavors", () => {
  it("--json matches its schema and counts slots per flavor", async () => {
    await seed({ "12sp9": 2, "23": 1 });
    await lease("12sp9");
    const r = await cli(["flavors", "--json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as { flavors: { flavor: string; engine: string; slots: object; media: unknown; baseline: unknown }[] };
    const validate = await validator("flavors.schema.json");
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.flavors.map((f) => [f.flavor, f.engine])).toEqual([
      ["12sp9", "12.0"],
      ["23", "14.0.7"],
      ["35", "14.35"],
    ]);
    expect(report.flavors[0]!.slots).toEqual({ free: 1, leased: 1, total: 2 });
    expect(report.flavors[2]!.slots).toEqual({ free: 0, leased: 0, total: 0 });
    expect(report.flavors.every((f) => f.baseline === true)).toBe(true);
  });

  it("finds media loose or inside a CD-image zip", async () => {
    await mkdir(join(media, "12sp9"), { recursive: true });
    for (const name of ["InnovatorSetup.msi", "Core120.bak", "CoreAndSolutions120.bak"]) await writeFile(join(media, "12sp9", name), "x");
    await mkdir(join(media, "23"), { recursive: true });
    await writeFile(
      join(media, "23", "Release 23 CD Image.zip"),
      buildZip(["InnovatorSetup.msi", "Core140.bak", "CoreAndSolutions140.bak"].map((name) => ({ name, data: "x" }))),
    );
    await mkdir(join(media, "35"), { recursive: true });
    await writeFile(join(media, "35", "Core140.bak"), "x");
    const report = JSON.parse((await cli(["flavors", "--json"])).stdout) as { flavors: { media: unknown }[] };
    expect(report.flavors.map((f) => f.media)).toEqual([true, true, false]);
  });

  it("reports the baseline as unknown when the host cannot be asked", async () => {
    const r = await cli(["flavors", "--json"], { ARASHOUSE_HOST: "" });
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { flavors: { baseline: unknown }[] }).flavors.map((f) => f.baseline)).toEqual([null, null, null]);
  });
});

describe("the reset (ticket 14)", () => {
  async function slotStatus(id: string): Promise<{ status: string; last_reset_ms: number | null; quarantine_reason: string | null }> {
    const report = JSON.parse((await cli(["status", "--json"])).stdout) as { slots: { slot: string; status: string; last_reset_ms: number | null; quarantine_reason: string | null }[] };
    const row = report.slots.find((s) => s.slot === id);
    if (!row) throw new Error(`no slot ${id}`);
    return row;
  }

  it("return starts a detached reset worker that takes the slot back to free", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    const r = await cli(["return", grant.lease_id, "--wait=30"], { ARASHOUSE_RESET_WORKER: "" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("23-01 is free again");
    expect((await slotStatus("23-01")).status).toBe("free");
  });

  it("get resets a dirty slot itself when none is free, and hands it out", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    expect((await cli(["return", grant.lease_id])).code).toBe(0);
    expect((await slotStatus("23-01")).status).toBe("dirty");
    const r = await cli(["get", "23", "--holder", "task-b", "--wait", "30", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as Grant).slot).toBe("23-01");
    expect((JSON.parse(r.stdout) as Grant).lease_id).not.toBe(grant.lease_id);
  });

  it("get --wait 0 with only a dirty slot exits 3 at once, saying it is being reset", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    expect((await cli(["return", grant.lease_id])).code).toBe(0);
    const r = await cli(["get", "23", "--holder", "task-b"]);
    expect(r.code).toBe(EXIT_CODES.noSlot);
    expect(r.stderr).toContain("23-01 is being reset");
  });

  it("reset-worker resets the slot, and exits 5 with the step named when the reset fails twice", async () => {
    await seed({ "23": 2 });
    const first = await lease("23");
    const second = await lease("23", "task-b");
    expect((await cli(["return", first.lease_id])).code).toBe(0);
    expect((await cli(["return", second.lease_id])).code).toBe(0);
    const ok = await cli(["reset-worker", "--slot", "23-01"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^23-01 reset in [\d.]+ s; free$/m);
    // It goes on to the other dirty slot.
    expect(ok.stdout).toMatch(/^23-02 reset in/m);
    expect((await slotStatus("23-02")).status).toBe("free");

    const again = await lease("23");
    expect((await cli(["return", again.lease_id])).code).toBe(0);
    const fault = JSON.stringify([{ method: "resetTree", kind: "fail", times: 2 }]);
    const failed = await cli(["reset-worker", "--slot", again.slot], { ARASHOUSE_FAKE_FAULTS: fault });
    expect(failed.code).toBe(EXIT_CODES.resetFailed);
    const row = await slotStatus(again.slot);
    expect(row.status).toBe("quarantined");
    expect(row.quarantine_reason).toContain("reset step tree failed twice");
    expect((await cli(["reset-worker", "--slot", "nope"])).code).toBe(EXIT_CODES.usage);
  });
});

describe("operator commands (ticket 16)", () => {
  it("destroy is a dry run without --yes, and refuses a leased slot without --include-leased", async () => {
    await seed({ "23": 2 });
    const grant = await lease("23");
    const dry = await cli(["destroy", "23-02"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/^would destroy 23-02: its record \(free\); application ah-23-02, /);
    expect(dry.stdout).toContain("dry run: nothing was changed; run again with --yes to do it");
    expect(JSON.parse((await cli(["status", "--json"])).stdout).slots).toHaveLength(2);

    const leased = await cli(["destroy", "23-01", "--yes"]);
    expect(leased.code).toBe(EXIT_CODES.refused);
    expect(leased.stderr).toContain("23-01 is leased (to task-a); destroy refuses a leased slot unless --include-leased");
    expect((await cli(["destroy", "23-02", "--yes"])).code).toBe(0);
    expect(JSON.parse((await cli(["status", "--json"])).stdout).slots.map((s: { slot: string }) => s.slot)).toEqual(["23-01"]);
    expect((await cli(["destroy", "23-01", "--yes", "--include-leased"])).code).toBe(0);
    expect(existsSync(join(home, "leases", grant.lease_id))).toBe(false);
  });

  it("teardown is a dry run without --yes, refuses a leased slot unless named, and checks its options (ticket 49)", async () => {
    await seed({ "23": 2 });
    const grant = await lease("23");
    const slots = async () => (JSON.parse((await cli(["status", "--json"])).stdout).slots as { slot: string; status: string }[]).map((s) => `${s.slot} ${s.status}`);
    const before = await slots();

    const refused = await cli(["teardown"]);
    expect(refused.code).toBe(EXIT_CODES.refused);
    expect(refused.stderr).toContain(`teardown refuses while slots are leased: ${grant.slot} (to task-a)`);

    const dry = await cli(["teardown", "--goldens", "--include-leased", grant.slot]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/^would destroy 23-01: its record \(leased\); application ah-23-01, /m);
    expect(dry.stdout).toMatch(/^would destroy 23-02: its record \(free\); /m);
    expect(dry.stdout).toContain("then, elevated, teardown.ps1");
    expect(dry.stdout).toContain("  remove the goldens: C:\\aras_installations\\golden\\12sp9, ");
    expect(dry.stdout).toContain("dry run: nothing was changed; run again with --yes to do it");
    expect(dry.stdout).toContain("with --yes it first writes teardown.ps1 and the two scripts it runs to arashouse-teardown in the Windows temp folder");
    expect(await slots()).toEqual(before);

    for (const [args, message] of [
      [["teardown", "23-01"], 'teardown names slots only after --include-leased, not "23-01"'],
      [["teardown", "--include-leased"], "--include-leased needs the exact name of every leased slot"],
      [["teardown", "--include-leased", grant.slot, "23-02"], "--include-leased names 23-02, which is not a leased slot of the pool"],
      [["teardown", "--remove-root"], "--remove-root removes golden\\ too: give --goldens with it"],
      [["teardown", "--goldens", "--remove-root", "--keep-sql"], "it cannot go with --keep-sql"],
    ] as const) {
      const r = await cli(args);
      expect(r.code, args.join(" ")).toBe(EXIT_CODES.usage);
      expect(r.stderr).toContain(message);
    }
    expect((await cli(["teardown", "--include-leased", "OLM_Local"])).code).toBe(EXIT_CODES.refused);
    expect(await slots()).toEqual(before);
  });

  it("provision makes the missing slots of a flavor, in order, and leaves the pool's own alone (ticket 25)", async () => {
    const first = await cli(["provision", "23", "2"]);
    expect(first.code).toBe(0);
    expect(first.stdout.trim().split("\n")).toEqual(["provisioned 23-01 (provisioned 23-01); free", "provisioned 23-02 (provisioned 23-02); free"]);
    const again = await cli(["provision", "23", "2"]);
    expect(again.stdout.trim().split("\n")).toEqual(["23-01 is in the pool already (free)", "23-02 is in the pool already (free)"]);
    expect(JSON.parse((await cli(["status", "--json"])).stdout).slots.map((s: { slot: string; status: string }) => `${s.slot} ${s.status}`)).toEqual(["23-01 free", "23-02 free"]);
    expect((await cli(["provision", "OLM_Local"])).code).toBe(EXIT_CODES.refused);
    for (const args of [["provision"], ["provision", "23", "x"], ["provision", "23", "0"], ["provision", "23", "1", "2"], ["provision", "14sp18"]]) {
      expect((await cli(args)).code, args.join(" ")).toBe(EXIT_CODES.usage);
    }
  });

  it("force-return takes the lease as status shows it, exits 4 on another, and needs --yes", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    const shown = JSON.parse((await cli(["status", "--json"])).stdout).slots[0].lease as string;
    expect((await cli(["force-return", "23-01", "--lease-id", "0123abcd", "--yes"])).code).toBe(EXIT_CODES.leaseMismatch);
    expect((await cli(["force-return", "23-01", "--yes"])).code).toBe(EXIT_CODES.usage);
    const dry = await cli(["force-return", "23-01", "--lease-id", shown]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("would force-return 23-01");
    expect(JSON.parse((await cli(["status", "--json"])).stdout).slots[0].status).toBe("leased");
    const done = await cli(["force-return", "23-01", "--lease-id", shown, "--yes"]);
    expect(done.code).toBe(0);
    expect(JSON.parse((await cli(["status", "--json"])).stdout).slots[0].status).toBe("dirty");
    expect(existsSync(join(home, "leases", grant.lease_id))).toBe(false);
  });

  it("disable and enable move a slot out of rotation and back through a reset", async () => {
    await seed({ "23": 1 });
    expect((await cli(["disable", "23-01"])).stdout).toContain("disabled 23-01 (it was free)");
    expect((await cli(["get", "23", "--holder", "x"])).code).toBe(EXIT_CODES.noSlot);
    const pruned = await cli(["prune"]);
    expect(pruned.stdout).toContain("would destroy 23-01 (disabled)");
    expect((await cli(["enable", "23-01"])).stdout).toContain("enabled 23-01: it is reset before it is handed out");
    expect(JSON.parse((await cli(["status", "--json"])).stdout).slots[0].status).toBe("dirty");
  });

  it("doctor passes on a clean pool, fails a corrupt state file, and fails with no broker", async () => {
    await seed({ "23": 1 });
    const ok = await cli(["doctor"]);
    expect(ok.code, ok.stdout).toBe(0);
    expect(ok.stdout).toContain("ok    slot 23-01: free and clean");
    expect((await cli(["doctor"], { ARASHOUSE_HOST: "" })).stdout).toContain("fail  broker: did not answer");
    await writeFile(join(home, "state.json"), "{");
    const corrupt = await cli(["doctor"]);
    expect(corrupt.code).toBe(1);
    expect(corrupt.stdout).toMatch(/fail {2}state: the state file .* is unusable/);
  });

  it("doctor --json prints its checks as one object, with the same exit code", async () => {
    await seed({ "23": 1 });
    const r = await cli(["doctor", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const report = JSON.parse(r.stdout) as { ok: boolean; exitCode: number; findings: { level: string; check: string; message: string }[] };
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.findings).toContainEqual({ level: "ok", check: "slot 23-01", message: "free and clean" });
    const down = await cli(["doctor", "--json"], { ARASHOUSE_HOST: "" });
    expect(down.code).toBe(1);
    expect((JSON.parse(down.stdout) as { ok: boolean }).ok).toBe(false);
  });

  it("refuses every deny-listed name with exit 7, and takes usage errors with exit 2", async () => {
    await seed({ "23": 1 });
    for (const args of [
      ["destroy", "OLM_Local", "--yes"],
      ["repair", "InnovatorServer23"],
      ["disable", "prod"],
      ["enable", "olm"],
      ["force-return", "12sp9", "--lease-id", "0123abcd", "--yes"],
    ]) {
      expect((await cli(args)).code, args.join(" ")).toBe(EXIT_CODES.refused);
    }
    for (const args of [["destroy"], ["repair", "23"], ["prune", "23-01"], ["doctor", "--fixx"], ["disable", "23-01", "23-02"]]) {
      expect((await cli(args)).code, args.join(" ")).toBe(EXIT_CODES.usage);
    }
  });
});

describe("help and version", () => {
  it("prints help for the tool and for each command", async () => {
    const overview = await cli(["help"]);
    expect(overview.code).toBe(0);
    const commands = ["get", "return", "status", "flavors", "run", "extract", "import", "setup", "setup-sql", "doctor", "provision", "repair", "destroy", "prune", "teardown", "force-return", "disable", "enable", "help", "version"];
    for (const command of commands) expect(overview.stdout).toContain(`  ${command}`);
    for (const command of ["get", "return", "status", "flavors", "run", "extract", "import", "media", "reset-worker", "setup", "setup-sql", "doctor", "repair", "destroy", "prune", "teardown", "force-return", "disable", "enable"]) {
      const r = await cli([command, "--help"]);
      expect(r.code, command).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`^usage: arashouse ${command}`));
    }
  });

  it("prints the package version", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string };
    for (const args of [["version"], ["--version"]]) {
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(`arashouse ${pkg.version}`);
    }
  });
});
