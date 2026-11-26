import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_IDENTITY } from "../core/git-baseline.js";
import { fakeGoldenHash } from "../host/fake.js";
import { StateStore } from "../core/store.js";
import type { DeployOptions, DeployResult } from "../host/driver.js";
import type { SlotRef } from "../core/names.js";
import { planSource } from "./code.js";
import { assertNoGitTargets, gitBaselineOnLease, refusedBaseline, selectGitTool, type GitDeps, type GitTarget } from "./git.js";

const ROOT = "C:\\aras_installations";
let dir: string;
let localRoot: string;
let tree: string;

/** A slot's `Innovator\` with code, a config, the slot's own files, secrets and runtime files. */
async function sampleTree(): Promise<void> {
  const files: Record<string, string> = {
    "web.config": "<configuration/>\r\n",
    "Client/web.config": "<configuration/>\r\n",
    "Client/scripts/Innovator.aspx": "<%@ Page %>\r\n",
    "Client/javascript/app.js": "var a = 1;\r\n",
    "Client/Innovator.xml": "<ConfigFilePath value=\"C:\\aras_installations\\slots\\12sp9\\01\\InnovatorServerConfig.xml\"/>",
    "Client/jsBundles/data.json": "{}",
    "Client/jsBundles/compile.log": "compiled",
    "Server/Innovator.xml": "<ConfigFilePath/>",
    "Server/OAuth.config": "<oauth/>",
    "Server/App_Data/Certificates/InnovatorServer.pfx": "pfx",
    "Server/App_Data/Certificates/OAuthServer.cer": "cer",
    "Server/App_Data/key-1.xml": "<key/>",
    "Server/bin/Aras.Server.Core.dll": "MZ",
    "Server/temp/today.log": "log",
    "Server/dll/m.dll": "MZ",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(tree, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(tree, ...path.split("/")), text);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arashouse-git-"));
  localRoot = join(dir, "root");
  tree = join(localRoot, "slots", "12sp9", "01", "Innovator");
  await sampleTree();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The broker's `deployCode`, as far as a baseline needs it: the staged files copied over `Innovator\`. */
function copyingHost(calls: { path: string; options: DeployOptions }[]) {
  return {
    async deployCode(_slot: SlotRef, stagedPath: string, options: DeployOptions): Promise<DeployResult> {
      calls.push({ path: stagedPath, options });
      const local = join(localRoot, ...stagedPath.slice(ROOT.length + 1).split("\\"));
      await cp(local, join(localRoot, "slots", "12sp9", "01", ...(options.subpath ?? "Innovator").split("/")), { recursive: true });
      return { ok: true, detail: "deployed; the slot is up", ms: 1, files: 0, deleted: 0, compiledCleared: false };
    },
  };
}

async function leased(): Promise<{ store: StateStore; target: GitTarget }> {
  const store = new StateStore({ home: join(dir, "home") });
  const lease = await store.update((tx) => {
    const s = tx.addSlot({ flavor: "12sp9", slot: 1 });
    tx.transition(s.id, { to: "free", golden_hash: fakeGoldenHash("12sp9"), reset_ms: 1 });
    return tx.transition(s.id, { to: "leased", holder: "t" }).lease!;
  });
  return { store, target: { slot: "12sp9-01", leaseId: lease.lease_id, flavor: "12sp9", agent: false } };
}

function deps(store: StateStore, host: GitDeps["host"]): GitDeps {
  return { store, host, git: selectGitTool("fake", {}, localRoot), localRoot, env: { PATH: process.env.PATH } };
}

/** git in the slot's tree, as a holder runs it. */
function git(...args: string[]): string {
  return execFileSync("git", ["-C", tree, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
}

describe("gitBaselineOnLease", () => {
  it("commits the tree as handed over, without secrets, slot files or runtime files, and a clean status after", async () => {
    const { store, target } = await leased();
    const calls: { path: string; options: DeployOptions }[] = [];
    const report = await gitBaselineOnLease(deps(store, copyingHost(calls)), target);
    expect(report.outcome, String(report.error)).toMatchObject({ ok: true, path: `${ROOT}\\slots\\12sp9\\01\\Innovator` });
    expect(calls).toEqual([{ path: `${ROOT}\\staging\\${target.leaseId}\\code\\1`, options: { leaseId: target.leaseId, subpath: "Innovator", allowConfig: false, allowServers: false, agent: false } }]);

    expect(git("ls-files").trim().split("\n").sort()).toEqual([
      ".gitignore",
      "Client/javascript/app.js",
      "Client/scripts/Innovator.aspx",
      "Client/web.config",
      "Server/bin/Aras.Server.Core.dll",
      "web.config",
    ]);
    expect(report.outcome.files).toBe(6);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "--format=%H|%an <%ae>|%cn|%s")).toBe(`${report.outcome.commit}|${GIT_IDENTITY.name} <${GIT_IDENTITY.email}>|${GIT_IDENTITY.name}|arashouse baseline 12sp9 ${target.leaseId}\n`);
    expect(git("remote")).toBe("");
    expect(git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git("config", "core.checkStat").trim()).toBe("minimal");
    // One pack, no loose object, nothing read-only.
    const objects = join(tree, ".git", "objects");
    expect((await readdir(objects)).sort()).toEqual(["info", "pack"]);
    for (const name of await readdir(join(objects, "pack"))) expect((await stat(join(objects, "pack", name))).mode & 0o200).toBe(0o200);

    // The server rewriting its runtime files changes nothing; a holder's edit is exactly that file.
    await writeFile(join(tree, "Client", "jsBundles", "compile.log"), "compiled again");
    await writeFile(join(tree, "Server", "temp", "tomorrow.log"), "log");
    await writeFile(join(tree, "Server", "App_Data", "key-2.xml"), "<key/>");
    expect(git("status", "--porcelain")).toBe("");
    await writeFile(join(tree, "Client", "javascript", "app.js"), "var a = 2;\r\n");
    expect(git("diff", "--name-only")).toBe("Client/javascript/app.js\n");

    expect((await store.read()).slots["12sp9-01"]?.lease?.bootstrap).toEqual({ git: report.outcome.commit });
    expect(await readdir(join(localRoot, "staging"))).toEqual([]);
  });

  it("refuses a commit that would hold a secret, and deploys nothing", async () => {
    const { store, target } = await leased();
    // A holder's .gitignore in the tree that un-ignores a certificate.
    await writeFile(join(tree, "Server", "App_Data", ".gitignore"), "!Certificates/\n!*.pfx\n");
    await writeFile(join(tree, "Server", "App_Data", "Other.pfx"), "pfx");
    const calls: { path: string; options: DeployOptions }[] = [];
    const report = await gitBaselineOnLease(deps(store, copyingHost(calls)), target);
    expect(report.outcome.ok).toBe(false);
    expect(report.outcome.detail).toMatch(/would commit 2 secret or identity files \(Server\/App_Data\/Certificates\/InnovatorServer\.pfx, Server\/App_Data\/Other\.pfx\)/);
    expect(refusedBaseline(report)).toBe(true);
    expect(calls).toEqual([]);
    expect((await store.read()).slots["12sp9-01"]?.lease?.bootstrap).toBeUndefined();
    expect(await readdir(join(localRoot, "staging"))).toEqual([]);
  });

  it("refuses a tree that already has a repository, and a lease that already has a baseline", async () => {
    const { store, target } = await leased();
    await writeFile(join(tree, ".gitignore"), "*\n");
    const first = await gitBaselineOnLease(deps(store, copyingHost([])), target);
    expect(first.outcome.detail).toMatch(/already has Innovator\\\.gitignore/);
    expect(refusedBaseline(first)).toBe(true);
    await rm(join(tree, ".gitignore"));
    expect((await gitBaselineOnLease(deps(store, copyingHost([])), target)).outcome.ok).toBe(true);
    const again = await gitBaselineOnLease(deps(store, copyingHost([])), target);
    expect(again.outcome.detail).toMatch(/the lease already has a git baseline/);
  });

  it("reports a deploy that failed, with the commit it made, and removes the staged copy", async () => {
    const { store, target } = await leased();
    const host = { deployCode: async (): Promise<DeployResult> => ({ ok: false, detail: "the slot did not come back up", ms: 1, files: 3, deleted: 0, compiledCleared: false }) };
    const report = await gitBaselineOnLease(deps(store, host), target);
    expect(report.outcome).toMatchObject({ ok: false, files: 6 });
    expect(report.outcome.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.outcome.detail).toMatch(/the slot did not come back up/);
    expect(await readdir(join(localRoot, "staging"))).toEqual([]);
  });
});

// Interop exists only from WSL; natively nothing fails that way (and a sh stub does not run on Windows).
describe.skipIf(process.platform === "win32")("WSL interop failing to start git", () => {
  it("runs git again, as git never ran", async () => {
    const { store, target } = await leased();
    // Fails the first time as interop does on a busy host, then is git.
    const stub = join(dir, "flaky-git");
    const marker = join(dir, "flaked");
    await writeFile(stub, `#!/bin/sh\nif [ ! -e "${marker}" ]; then : > "${marker}"; echo "<3>WSL (1 - ) ERROR: UtilAcceptVsock:273: accept4 failed 110" >&2; exit 1; fi\nexec git "$@"\n`, { mode: 0o755 });
    const base = deps(store, copyingHost([]));
    const report = await gitBaselineOnLease({ ...base, git: { ...base.git, exe: stub } }, target);
    expect(report.outcome, String(report.error)).toMatchObject({ ok: true, files: 6 });
  });
});

describe("selectGitTool", () => {
  it("runs Git for Windows on Windows paths on the host, with the worker's config kept out across interop", () => {
    const tool = selectGitTool("broker", { WSLENV: "FOO/p" }, "/mnt/c/aras_installations", ROOT, "wsl");
    expect(tool.exe).toBe("/mnt/c/Program Files/Git/cmd/git.exe");
    expect(tool.path(`${ROOT}\\slots\\23\\01\\Innovator`)).toBe(`${ROOT}\\slots\\23\\01\\Innovator`);
    expect(tool.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", WSLENV: "FOO/p:GIT_CONFIG_NOSYSTEM:GIT_CONFIG_GLOBAL:GIT_TERMINAL_PROMPT" });
    expect(selectGitTool("broker", { ARASHOUSE_WINDOWS_GIT: "/x/git.exe" }, "/r", ROOT, "wsl").exe).toBe("/x/git.exe");
    const fake = selectGitTool("fake", {}, join(dir, "r"));
    expect(fake.path(`${ROOT}\\slots\\23\\01`)).toBe(join(dir, "r", "slots", "23", "01"));
    expect(() => fake.path("D:\\elsewhere")).toThrow(/not under/);
  });

  it("natively runs git.exe from the PATH, else its install folder, with no WSLENV", () => {
    const tool = selectGitTool("broker", { WSLENV: "FOO/p", PATH: "" }, "C:\\aras_installations", ROOT, "windows");
    expect(tool.exe).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(tool.env).toEqual({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_TERMINAL_PROMPT: "0" });
    // A git.exe the WSL launcher named through its mount is the drive path itself.
    expect(selectGitTool("broker", { ARASHOUSE_WINDOWS_GIT: "/mnt/d/tools/git.exe", ARASHOUSE_WSL_DISTRO: "Ubuntu" }, "C:\\r", ROOT, "windows").exe).toBe("D:\\tools\\git.exe");
    expect(selectGitTool("broker", { ARASHOUSE_WINDOWS_GIT: "D:\\git\\git.exe" }, "C:\\r", ROOT, "windows").exe).toBe("D:\\git\\git.exe");
    expect(selectGitTool("fake", {}, "C:\\r", ROOT, "windows").env).toMatchObject({ GIT_CONFIG_GLOBAL: "NUL" });
  });
});

describe("assertNoGitTargets", () => {
  it("refuses a --code source that writes Innovator\\.git or Innovator\\.gitignore", async () => {
    const src = join(dir, "src");
    await mkdir(join(src, ".git"), { recursive: true });
    await writeFile(join(src, ".git", "HEAD"), "ref: refs/heads/main\n");
    const rules = { allowConfig: false, allowServers: false };
    expect(() => assertNoGitTargets([])).not.toThrow();
    const planned = await planSource(src, rules);
    expect(() => assertNoGitTargets([planned])).toThrow(/writes Innovator\/\.git\/HEAD, which the git baseline makes/);
    await rm(join(src, ".git"), { recursive: true });
    await writeFile(join(src, "a.js"), "a");
    const plain = await planSource(src, rules);
    expect(() => assertNoGitTargets([plain])).not.toThrow();
  });
});
