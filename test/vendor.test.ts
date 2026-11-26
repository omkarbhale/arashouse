// `npm run vendor -- <dest>` (scripts/vendor.mjs): the payload a Windows tool runs arashouse from, and that copy
// working outside any arashouse checkout: `version` names its build, `flavors --json` finds the media through
// config.json, and `doctor` runs (all against the fake host).

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const run = promisify(execFile);
const VENDOR = join(repoRoot, "scripts", "vendor.mjs");

let work: string;
/** A built arashouse, as `npm run build` leaves it, outside the checkout. */
let built: string;

async function vendor(dest: string, from = built): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [VENDOR, "--from", from, dest], { encoding: "utf8", env: { ...process.env, INIT_CWD: work } });
    return { code: 0, ...r };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "arashouse-vendor-"));
  built = join(work, "built");
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(built, "dist")], { cwd: repoRoot });
  await writeFile(join(built, "dist", "build.json"), JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", dirty: false, built_at: "2026-11-26T10:00:00.000Z" }));
  await cp(join(repoRoot, "package.json"), join(built, "package.json"));
  await cp(join(repoRoot, "scripts"), join(built, "scripts"), { recursive: true });
  await cp(join(repoRoot, "docs", "schemas"), join(built, "docs", "schemas"), { recursive: true });
  await mkdir(join(built, "media"), { recursive: true });
  await cp(join(repoRoot, "media", "README.md"), join(built, "media", "README.md"));
}, 180_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("npm run vendor", () => {
  it("copies the build without maps, sources, tests or bash, with a package.json of its own", async () => {
    const dest = join(work, "mrenv", "vendor", "arashouse");
    const r = await vendor(dest);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/vendored arashouse 0\.0\.0 build 0123456789ab to /);
    const top = (await readdir(dest)).sort();
    expect(top).toEqual(["README.md", "VENDORED.json", "dist", "docs", "media", "package.json", "scripts"]);
    expect(existsSync(join(dest, "dist", "cli", "index.js"))).toBe(true);
    expect(existsSync(join(dest, "dist", "broker", "client.js"))).toBe(true);
    expect(existsSync(join(dest, "dist", "build.json"))).toBe(true);
    const all = await readdir(dest, { recursive: true });
    expect(all.filter((f) => /\.(map|ts|sh)$/.test(f))).toEqual([]);
    expect((await readdir(join(dest, "scripts"))).every((f) => f.endsWith(".ps1"))).toBe(true);
    expect(await readdir(join(dest, "docs", "schemas"))).toContain("env.schema.json");
    const pkg = JSON.parse(await readFile(join(dest, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg).toMatchObject({ name: "arashouse", type: "module" });
    expect(pkg).not.toHaveProperty("devDependencies");
    expect(pkg).not.toHaveProperty("scripts");
    expect(JSON.parse(await readFile(join(dest, "VENDORED.json"), "utf8"))).toMatchObject({ build: "0123456789ab" });
  });

  it("replaces an earlier copy whole, and refuses a folder that holds anything else", async () => {
    const dest = join(work, "again");
    expect((await vendor(dest)).code).toBe(0);
    await writeFile(join(dest, "dist", "stale.js"), "x");
    expect((await vendor(dest)).code).toBe(0);
    expect(existsSync(join(dest, "dist", "stale.js"))).toBe(false);

    const foreign = join(work, "foreign");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "notes.txt"), "mine");
    const refused = await vendor(foreign);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/holds notes\.txt, and is not an earlier vendored copy/);
    expect(await readdir(foreign)).toEqual(["notes.txt"]);
  });

  it("refuses an unbuilt tree, and a destination inside the source", async () => {
    const unbuilt = join(work, "unbuilt");
    await mkdir(unbuilt, { recursive: true });
    await writeFile(join(unbuilt, "package.json"), JSON.stringify({ name: "arashouse" }));
    expect((await vendor(join(work, "x"), unbuilt)).stderr).toMatch(/run `npm run build` first/);
    expect((await vendor(join(built, "inside"))).stderr).toMatch(/must not contain each other/);
  });
});

describe("a vendored copy, outside any arashouse checkout", () => {
  let bin: string;
  let home: string;

  beforeAll(async () => {
    const dest = join(work, "outside", "arashouse");
    expect((await vendor(dest)).code).toBe(0);
    bin = join(dest, "dist", "cli", "index.js");
    home = join(work, "state");
    await mkdir(join(work, "media", "23"), { recursive: true });
    for (const name of ["InnovatorSetup.msi", "Core140.bak", "CoreAndSolutions140.bak"]) await writeFile(join(work, "media", "23", name), "x");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ media: join(work, "media") }));
  });

  const cli = async (...args: string[]) => {
    const env = { PATH: process.env.PATH, ARASHOUSE_HOME: home, ARASHOUSE_HOST: "fake", ARASHOUSE_RESET_WORKER: "off" };
    try {
      const r = await run(process.execPath, [bin, ...args], { encoding: "utf8", env, cwd: work });
      return { code: 0, ...r };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };

  it("names its build", async () => {
    const r = await cli("version");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("arashouse 0.0.0 (build 0123456789ab)");
  });

  it("finds its media through config.json, never a repository's media/", async () => {
    const r = await cli("flavors", "--json");
    expect(r.code, r.stderr).toBe(0);
    const media = (JSON.parse(r.stdout) as { flavors: { flavor: string; media: boolean | null }[] }).flavors.map((f) => [f.flavor, f.media]);
    expect(media).toEqual([
      ["12sp9", false],
      ["23", true],
      ["35", false],
    ]);
  });

  it("runs doctor", async () => {
    const r = await cli("doctor");
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("ok    media 23: present");
  });
});
