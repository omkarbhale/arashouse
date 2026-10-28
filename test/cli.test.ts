// The CLI surface (ticket 15), tested by spawning the built binary against the fake host
// (`ARASHOUSE_HOST=fake`). Each test gets its own ARASHOUSE_HOME, seeded with free slots.

import { execFile, spawn } from "node:child_process";
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
        env: { PATH: process.env.PATH, HOME: home, ARASHOUSE_HOME: home, ARASHOUSE_HOST: "fake", ARASHOUSE_MEDIA: media, ARASHOUSE_RESET_WORKER: "off", ARASHOUSE_WINDOWS_NODE: join(home, "no-node.exe"), ...env },
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

  it("writes the password to the descriptor, and --json leaves it out", async () => {
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

  it("says where the password went without --json", async () => {
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
    // Without a descriptor 3 from the caller, 3 and up are Node's own (its event loop's): never written to.
    for (const fd of ["3", "9"]) {
      const closed = await cli(["get", "23", "--holder", "task-a", "--password-fd", fd]);
      expect(closed.code, fd).toBe(EXIT_CODES.usage);
      expect(closed.stderr).toContain(`--password-fd ${fd} is not open`);
    }
    expect((await new StateStore({ home }).read()).slots["23-01"]?.status).toBe("free");
  });
});

describe("run --lease", () => {
  it("gives the password to the child's environment and to nothing else", async () => {
    await seed({ "23": 2 });
    const grant = await lease("23");
    const envFile = join(home, "child-env.txt");
    const r = await cli(["--verbose", "run", "--lease", grant.lease_id, "--", "sh", "-c", 'env > "$1"', "sh", envFile], { ARASHOUSE_DEBUG: "1" });
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
    await cli(["run", "--lease", grant.lease_id, "--", "sh", "-c", "exit 3"]);
    await cli(["return", "23-01", "--if-lease-id", "0".repeat(32)], { ARASHOUSE_DEBUG: "1" });
    await cli(["--verbose", "return", grant.lease_id]);
    await cli(["run", "--lease", grant.lease_id, "--", "true"], { ARASHOUSE_DEBUG: "1" });
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
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "leases")).mode & 0o777).toBe(0o700);
    expect((await cli(["return", grant.lease_id])).code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(await readdir(join(home, "leases"))).toEqual([]);
  });

  it("passes the command's exit code through, and 127 when it cannot start", async () => {
    await seed({ "23": 1 });
    const grant = await lease("23");
    expect((await cli(["run", "--lease", grant.lease_id, "--", "sh", "-c", "exit 9"])).code).toBe(9);
    expect((await cli(["run", "--lease", grant.lease_id, "--", "sh", "-c", "exit 0"])).code).toBe(0);
    const missing = await cli(["run", "--lease", grant.lease_id, "--", "no-such-command-arashouse"]);
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain("cannot run");
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
    const commands = ["get", "return", "status", "flavors", "run", "extract", "setup", "setup-sql", "doctor", "provision", "repair", "destroy", "prune", "teardown", "force-return", "disable", "enable", "help", "version"];
    for (const command of commands) expect(overview.stdout).toContain(`  ${command}`);
    for (const command of ["get", "return", "status", "flavors", "run", "extract", "media", "reset-worker", "setup", "setup-sql", "doctor", "repair", "destroy", "prune", "teardown", "force-return", "disable", "enable"]) {
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
