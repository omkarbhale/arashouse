import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT_FOLDERS } from "../core/setup-host.js";
import { collectAppFiles, flavorsToCheck, observeSetup, workerIdentity, writeSetupBundle, writeSetupSqlScript, wslPathOf } from "./setup.js";

const dir = await mkdtemp(join(tmpdir(), "arashouse-setup-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const worker = { name: "sg\\omkarb", sid: "S-1-5-21-1111111111-2222222222-3333333333-1001" };

async function fakeDist(name: string): Promise<string> {
  const dist = join(dir, name);
  await mkdir(join(dist, "broker"), { recursive: true });
  await mkdir(join(dist, "core"), { recursive: true });
  await writeFile(join(dist, "broker", "index.js"), "// index\n");
  await writeFile(join(dist, "broker", "client.js"), "// client\n");
  await writeFile(join(dist, "core", "names.js"), "// names\n");
  return dist;
}

describe("arashouse setup: the bundle", () => {
  it("asks whoami.exe for the worker user", async () => {
    const run = async (file: string, args: string[]) => {
      expect([file, ...args]).toEqual(["whoami.exe", "/user", "/fo", "csv", "/nh"]);
      return `"${worker.name}","${worker.sid}"\r\n`;
    };
    expect(await workerIdentity(run)).toEqual(worker);
    await expect(workerIdentity(async () => '"NT AUTHORITY\\SYSTEM","S-1-5-18"\r\n')).rejects.toThrow(/account SID/);
    await expect(workerIdentity(async () => Promise.reject(new Error("not WSL")))).rejects.toThrow(/WSL interop/);
  });

  it("lists the build with each file's SHA-256, relative and with backslashes", async () => {
    const files = await collectAppFiles(await fakeDist("dist-list"));
    expect(files).toEqual([
      { path: "broker\\client.js", sha256: createHash("sha256").update("// client\n").digest("hex") },
      { path: "broker\\index.js", sha256: createHash("sha256").update("// index\n").digest("hex") },
      { path: "core\\names.js", sha256: createHash("sha256").update("// names\n").digest("hex") },
    ]);
  });

  it("writes the script (CRLF, ASCII), package.json and the build, and replaces an earlier bundle", async () => {
    const distDir = await fakeDist("dist-write");
    const packageJson = join(dir, "package.json");
    await writeFile(packageJson, '{ "name": "arashouse", "version": "0.0.0", "type": "module" }\n');
    const outDir = join(dir, "bundle");
    const options = { outDir, distDir, packageJson, version: "0.0.0", worker, flavors: ["23" as const] };
    const bundle = await writeSetupBundle(options);
    expect(bundle).toEqual({ script: join(outDir, "setup-host.ps1"), files: 3 });
    const script = await readFile(bundle.script, "utf8");
    expect(script).toMatch(/^[\x00-\x7f]*$/);
    expect(script.split("\r\n").length).toBeGreaterThan(100);
    expect(script.replace(/\r\n/g, "")).not.toContain("\n");
    expect(script).toContain(`$PackageJsonSha256 = '${createHash("sha256").update(await readFile(packageJson)).digest("hex")}'`);
    expect(script).toContain("id = 'aspnetcore-6.0'; flavors = '23'");
    expect(await readFile(join(outDir, "app", "core", "names.js"), "utf8")).toBe("// names\n");
    expect((await readdir(outDir)).sort()).toEqual(["app", "package.json", "setup-host.ps1"]);

    await writeFile(join(outDir, "app", "stale.js"), "old");
    await writeSetupBundle(options);
    expect((await readdir(join(outDir, "app"))).sort()).toEqual(["broker", "core"]);
  });

  it("refuses a folder that holds something else, and a source that is not a build", async () => {
    const distDir = await fakeDist("dist-refuse");
    const packageJson = join(dir, "package.json");
    const outDir = join(dir, "busy");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "notes.txt"), "mine");
    const options = { outDir, distDir, packageJson, version: "0.0.0", worker, flavors: ["23" as const] };
    await expect(writeSetupBundle(options)).rejects.toThrow(/holds notes\.txt/);
    expect(await readdir(outDir)).toEqual(["notes.txt"]);
    await expect(writeSetupBundle({ ...options, outDir: join(dir, "fresh"), distDir: join(dir, "nowhere") })).rejects.toThrow(/run it from the build/);
  });

  it("checks the flavors with media, or every flavor when none can be told", async () => {
    expect(await flavorsToCheck(async (f) => f !== "12sp9")).toEqual(["23", "35"]);
    expect(await flavorsToCheck(async () => null)).toEqual(["12sp9", "23", "35"]);
    expect(await flavorsToCheck(async () => Promise.reject(new Error("x")))).toEqual(["12sp9", "23", "35"]);
  });

  it("maps a Windows drive path to its WSL path", () => {
    expect(wslPathOf("C:\\aras_installations")).toBe("/mnt/c/aras_installations");
    expect(wslPathOf("D:\\a\\b\\")).toBe("/mnt/d/a/b");
    expect(() => wslPathOf("\\\\server\\share")).toThrow(/not a Windows drive path/);
  });
});

describe("arashouse setup-sql: the script", () => {
  it("writes setup-sql.ps1 (CRLF, ASCII), replaces an earlier one, and refuses a folder holding anything else", async () => {
    const outDir = join(dir, "sql");
    const path = await writeSetupSqlScript({ outDir, version: "0.0.0" });
    expect(path).toBe(join(outDir, "setup-sql.ps1"));
    const text = await readFile(path, "utf8");
    expect(text).toMatch(/^[\x00-\x7f]*$/);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text).toContain("$AdminDatabase = 'arashouse_admin'");
    await writeSetupSqlScript({ outDir, version: "0.0.1" });
    expect(await readdir(outDir)).toEqual(["setup-sql.ps1"]);
    expect(await readFile(path, "utf8")).toContain("$ToolVersion = '0.0.1'");

    await writeFile(join(outDir, "notes.txt"), "mine");
    await expect(writeSetupSqlScript({ outDir, version: "0.0.0" })).rejects.toThrow(/holds notes\.txt/);
  });
});

describe("arashouse doctor: what it sees of the setup", () => {
  const runsAsRoot = process.getuid?.() === 0;

  it.skipIf(runsAsRoot)("reads the record and tells listable, closed and missing folders apart", async () => {
    const local = join(dir, "host");
    const root = "C:\\aras_installations";
    const toLocal = (p: string) => join(local, ...p.slice(root.length).split("\\").filter(Boolean));
    for (const folder of ROOT_FOLDERS.filter((f) => f !== "vaults")) await mkdir(join(local, folder), { recursive: true });
    await writeFile(join(local, "broker", "setup-host.json"), JSON.stringify({ ok: true }));
    await chmod(join(local, "secrets"), 0o000);
    try {
      const seen = await observeSetup({ root, toLocal });
      expect(seen.rootExists).toBe(true);
      expect(seen.record).toEqual({ ok: true });
      expect(seen.access.secrets).toBe("denied");
      expect(seen.access.vaults).toBe("missing");
      expect(seen.access.staging).toBe("read");

      await writeFile(join(local, "broker", "setup-host.json"), "{");
      expect((await observeSetup({ root, toLocal })).record).toBeInstanceOf(Error);
      await rm(join(local, "broker", "setup-host.json"));
      expect((await observeSetup({ root, toLocal })).record).toBeNull();
    } finally {
      await chmod(join(local, "secrets"), 0o755);
    }
    expect((await observeSetup({ root, toLocal: () => join(dir, "absent") })).rootExists).toBe(false);
  });
});
