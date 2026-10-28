// Ticket 53's proof on the real host (docs/git-baseline.md): a git baseline of a lease of each flavor, run from WSL,
// non-elevated, by test/host/git-baseline.test.ts (ARASHOUSE_TEST_GIT=1). Every step is a line in
// `<out>/git-proof.log` and `.json`. Per flavor:
//
// 1. `get <flavor> --code <a one-file client overlay> --git`: the repository's one commit holds the golden tree plus the
//    overlay, by arashouse, with no remote and no protected file; `git status` is clean, with Git for Windows (as the
//    worker) and with WSL's git (read-only, through `/mnt/c`).
// 2. The slot exercised without the holder touching its tree: its pages read, root logs in and reads items, the pools
//    recycled and the slot restarted (`deploy-code` of the overlay's same bytes: the pools and agent stopped and
//    started), and again. Every file that changed meanwhile (a stat snapshot of `Innovator\`, before and after) is
//    listed with whether the `.gitignore` ignores it; `git status` is still clean.
// 3. One client file edited (`deploy-code` of a golden `Client\javascript` file with a line appended): `git diff` names
//    exactly that file.
// 4. `return --wait`: the reset (with its `fast` verify) passes, and `.git` and `.gitignore` are gone.
// The deny-list objects the worker can read are fingerprinted before and after.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlavorKey } from "../../src/core/flavors.js";
import { GIT_IDENTITY, isNeverCommitted } from "../../src/core/git-baseline.js";
import { redact } from "../../src/core/redact.js";
import { Secret } from "../../src/core/secret.js";
import { DEFAULT_WINDOWS_GIT } from "../../src/cli/git.js";
import { repoRoot } from "../helpers.js";
import { ArasClient } from "./aras-client.js";
import { denyListPrints, runProcess } from "./e2e-cycle.js";

const CLI = join(repoRoot, "dist/cli/index.js");
const ROOT_WSL = "/mnt/c/aras_installations";

export interface ProofRecord {
  readonly step: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** path -> "size mtime" of every file under `dir`, `.git\` left out; stat only, no content. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (folder: string, rel: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (path === ".git") continue;
      if (entry.isDirectory()) walk(join(folder, entry.name), path);
      else if (entry.isFile()) {
        const info = statSync(join(folder, entry.name));
        out.set(path, `${info.size} ${info.mtimeMs}`);
      }
    }
  };
  walk(dir, "");
  return out;
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort();
}

export async function runGitProof(out: string, flavors: readonly FlavorKey[]): Promise<ProofRecord[]> {
  mkdirSync(out, { recursive: true });
  const tag = randomBytes(4).toString("hex");
  const logFile = join(out, "git-proof.log");
  writeFileSync(logFile, `ticket 53 git baseline proof, tag ${tag}, started ${new Date().toISOString()}\n`);
  const records: ProofRecord[] = [];
  const passwords: Secret[] = [];
  const outputs: string[] = [];
  const record = (step: string, ok: boolean, detail: string, ms = 0) => {
    const line = redact(detail).replace(/\s+/g, " ").slice(0, 900);
    records.push({ step, ok, ms, detail: line });
    const text = `${ok ? "ok  " : "FAIL"} ${step} (${(ms / 1000).toFixed(1)} s): ${line}`;
    appendFileSync(logFile, `${text}\n`);
    console.log(text);
  };
  const cli = (args: string[], timeoutMs = 30 * 60_000): Promise<CliRun> =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [CLI, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (!(args[0] === "get" && args.includes("--json"))) outputs.push(stdout);
        outputs.push(stderr);
        resolve({ code, stdout, stderr, ms: Date.now() - started });
      });
    });
  const oneLine = (run: CliRun) => `exit ${run.code}: ${`${run.stdout} ${run.stderr}`.replace(/\s+/g, " ").trim()}`.slice(0, 600);
  const windowsGit = process.env.ARASHOUSE_WINDOWS_GIT?.trim() || DEFAULT_WINDOWS_GIT;
  /** Git for Windows in the slot's tree, as the worker; the repository is the broker's, so its owner is not the worker. */
  const gitWin = async (worktree: string, ...args: string[]) => {
    const started = Date.now();
    const r = await runProcess(windowsGit, ["-c", "safe.directory=*", "-C", worktree, ...args]);
    outputs.push(r.stdout, r.stderr);
    return { ...r, ms: Date.now() - started };
  };
  const gitWsl = async (worktree: string, ...args: string[]) => {
    const started = Date.now();
    const r = await runProcess("git", ["-C", worktree, ...args]);
    outputs.push(r.stdout, r.stderr);
    return { ...r, ms: Date.now() - started };
  };
  const fetchStatus = async (url: string): Promise<number> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      await res.arrayBuffer();
      return res.status;
    } catch {
      return 0;
    }
  };

  const deny0 = await denyListPrints();
  record("deny-list before", true, `${Object.keys(deny0).length} objects fingerprinted`);

  for (const flavor of flavors) {
    const overlay = join(out, `${flavor}-overlay`);
    rmSync(overlay, { recursive: true, force: true });
    mkdirSync(join(overlay, "Client"), { recursive: true });
    const overlayName = `arashouse-53-${tag}.txt`;
    writeFileSync(join(overlay, "Client", overlayName), `arashouse 53 ${tag}\r\n`);

    // ---- 1. get --code --git ------------------------------------------------------------------------------
    const got = await cli(["get", flavor, "--holder", `git-53-${tag}`, "--json", "--wait", "900", "--code", overlay, "--git"]);
    if (got.code !== 0) {
      // stdout is the lease contract, password and all: only stderr is recorded.
      record(`${flavor}: get --code --git`, false, `exit ${got.code}: ${got.stderr.replace(/\s+/g, " ").trim()}`, got.ms);
      if (got.code === 10) await cli(["return", (JSON.parse(got.stdout) as { lease_id: string }).lease_id, "--quiet"]);
      continue;
    }
    const grant = JSON.parse(got.stdout) as {
      slot: string; url: string; database: string; lease_id: string; password: string;
      bootstrap: { code: { ok: boolean; files: number; detail: string }[]; git: { ok: boolean; commit: string; files: number; path: string; detail: string } };
    };
    const password = Secret.of(grant.password, "lease-password");
    passwords.push(password);
    const leaseId = grant.lease_id;
    const winTree = grant.bootstrap.git.path;
    const wslTree = join(ROOT_WSL, "slots", flavor, grant.slot.slice(-2), "Innovator");
    let held = true;
    try {
      record(`${flavor}: get --code --git`, grant.bootstrap.code.every((c) => c.ok) && grant.bootstrap.git.ok, `${grant.slot}: code ${grant.bootstrap.code.map((c) => c.detail).join(" | ")}; git ${grant.bootstrap.git.detail}`, got.ms);
      const state = JSON.parse(readFileSync(join(process.env.ARASHOUSE_HOME as string, "state.json"), "utf8")) as { slots: { id: string; lease?: { bootstrap?: Record<string, unknown> } }[] };
      const bootstrap = state.slots.find((s) => s.id === grant.slot)?.lease?.bootstrap;
      record(`${flavor}: the lease records the commit`, bootstrap?.git === grant.bootstrap.git.commit, JSON.stringify(bootstrap ?? null));

      const log = await gitWin(winTree, "log", "--format=%H|%an <%ae>|%cn <%ce>|%s");
      const expected = `${grant.bootstrap.git.commit}|${GIT_IDENTITY.name} <${GIT_IDENTITY.email}>|${GIT_IDENTITY.name} <${GIT_IDENTITY.email}>|arashouse baseline ${flavor} ${leaseId}`;
      record(`${flavor}: one commit, by arashouse`, log.code === 0 && log.stdout.trim() === expected, log.stdout.trim() || log.stderr.trim());
      const remotes = await gitWin(winTree, "remote");
      record(`${flavor}: no remote`, remotes.code === 0 && remotes.stdout.trim() === "", `git remote: "${remotes.stdout.trim()}" ${remotes.stderr.trim()}`);
      const files = (await gitWin(winTree, "ls-files", "-z")).stdout.split("\0").filter(Boolean);
      const secret = files.filter((f) => isNeverCommitted(flavor, f));
      record(`${flavor}: the commit holds the tree and the overlay, no protected file`, files.length === grant.bootstrap.git.files && files.includes(`Client/${overlayName}`) && secret.length === 0, `${files.length} files tracked; overlay ${files.includes(`Client/${overlayName}`) ? "tracked" : "missing"}; protected tracked: ${secret.length} ${secret.slice(0, 3).join(", ")}`);
      const ignoredProtected = (await gitWin(winTree, "ls-files", "--others", "--ignored", "--exclude-standard")).stdout.split("\n").filter((f) => f !== "" && isNeverCommitted(flavor, f));
      record(`${flavor}: the protected files in the tree are ignored`, true, `${ignoredProtected.length} ignored: ${ignoredProtected.slice(0, 8).join(", ")}`);

      const statusAll = async (when: string) => {
        const st = await gitWin(winTree, "status", "--porcelain", "--untracked-files=all");
        record(`${flavor}: git status (Git for Windows) ${when}`, st.code === 0 && st.stdout.trim() === "", `${st.stdout.trim().split("\n").slice(0, 10).join("; ") || "clean"} ${st.stderr.trim()}`, st.ms);
      };
      await statusAll("after get");
      const wsl = await gitWsl(wslTree, "status", "--porcelain");
      record(`${flavor}: git status (WSL git, read-only, through /mnt/c) after get`, wsl.code === 0 && wsl.stdout.trim() === "", `${wsl.stdout.trim().split("\n").slice(0, 5).join("; ") || "clean"} ${wsl.stderr.trim()}`, wsl.ms);

      // ---- 2. exercised, recycled, restarted -------------------------------------------------------------------
      const before = snapshot(wslTree);
      const client = new ArasClient(grant.url, grant.database);
      const exercise = async (round: number) => {
        const pages = await Promise.all(["Client/", "Server/DBList.aspx", "OAuthServer/.well-known/openid-configuration"].map((p) => fetchStatus(`${grant.url}/${p}`)));
        const login = await client.login("root", password);
        const reads: string[] = [];
        if (login.ok) {
          for (const [name, aml] of [
            ["ItemType Part", `<Item type="ItemType" action="get" select="name"><name>Part</name></Item>`],
            ["Users", `<Item type="User" action="get" select="login_name"/>`],
            ["Forms", `<Item type="Form" action="get" select="name" maxRecords="20"><Relationships><Item type="Body" action="get"/></Relationships></Item>`],
            ["Methods", `<Item type="Method" action="get" select="name" maxRecords="50"/>`],
          ] as const) {
            const a = await client.apply(login.token, aml);
            reads.push(`${name} ${a.ok ? `${(a.body.match(/<Item /g) ?? []).length} items` : `fault ${a.fault ?? ""}`}`);
          }
        }
        record(`${flavor}: exercised (${round})`, pages.every((s) => s === 200) && login.ok, `pages ${pages.join(", ")}; login ${login.ok ? "ok" : login.detail}; ${reads.join("; ")}`);
      };
      const recycle = async (round: number) => {
        const dep = await cli(["deploy-code", "--lease", leaseId, overlay]);
        record(`${flavor}: recycled and restarted (${round}: the overlay's same bytes deployed)`, dep.code === 0, oneLine(dep), dep.ms);
      };
      await exercise(1);
      await recycle(1);
      await exercise(2);
      await recycle(2);
      await exercise(3);
      const moved = changed(before, snapshot(wslTree)).filter((p) => p !== `Client/${overlayName}`);
      const ignored = moved.length === 0 ? [] : (await gitWin(winTree, "check-ignore", "--no-index", ...moved)).stdout.split("\n").filter(Boolean);
      record(`${flavor}: every file the server changed meanwhile is ignored`, moved.every((p) => ignored.includes(p)), `${moved.length} changed: ${moved.map((p) => `${p}${ignored.includes(p) ? "" : " (NOT ignored)"}`).join(", ") || "none"}`);
      await statusAll("after logging in, recycling and restarting");

      // ---- 3. one client file edited ----------------------------------------------------------------------------
      // 12 SP9 has scripts at the top of Client\javascript; 14.x only in its subfolders (dijit, ...).
      const target = files.find((f) => /^Client\/javascript\/[^/]+\.js$/i.test(f)) ?? files.find((f) => /^Client\/javascript\/.+\.js$/i.test(f));
      if (target === undefined) {
        record(`${flavor}: a client file to edit`, false, "no Client/javascript/**/*.js is tracked");
      } else {
        const edit = join(out, `${flavor}-edit`);
        rmSync(edit, { recursive: true, force: true });
        mkdirSync(dirname(join(edit, target)), { recursive: true });
        writeFileSync(join(edit, target), Buffer.concat([readFileSync(join(wslTree, target)), Buffer.from(`\r\n// arashouse 53 ${tag}\r\n`)]));
        const dep = await cli(["deploy-code", "--lease", leaseId, edit]);
        const diff = await gitWin(winTree, "diff", "--name-only");
        const st = await gitWin(winTree, "status", "--porcelain", "--untracked-files=all");
        record(`${flavor}: an edited client file is exactly the diff`, dep.code === 0 && diff.stdout.trim() === target && st.stdout.trim() === `M ${target}`, `deploy-code exit ${dep.code}; git diff --name-only: ${diff.stdout.trim()}; status: ${st.stdout.trim()}`, dep.ms);
      }

      // ---- 4. return and the reset ------------------------------------------------------------------------------
      const ret = await cli(["return", leaseId, "--wait", "--quiet"]);
      held = false;
      record(`${flavor}: return --wait (the reset and its fast verify)`, ret.code === 0 && /is free again/.test(ret.stdout), oneLine(ret), ret.ms);
      const gone = [".git", ".gitignore"].filter((n) => existsSync(join(wslTree, n)) || (() => { try { lstatSync(join(wslTree, n)); return true; } catch { return false; } })());
      record(`${flavor}: .git and .gitignore are gone after the reset`, gone.length === 0, gone.length === 0 ? "both gone" : `still there: ${gone.join(", ")}`);
    } catch (err) {
      record(`${flavor}: the proof itself`, false, err instanceof Error ? err.message : String(err));
    } finally {
      if (held) await cli(["return", leaseId, "--quiet"]);
    }
  }

  const deny1 = await denyListPrints();
  record("the deny-list objects are unchanged", JSON.stringify(deny1) === JSON.stringify(deny0), `${Object.keys(deny1).length} objects`);
  const leaked = passwords.filter((p) => outputs.some((o) => o.includes(p.reveal())));
  record("no lease password in any output but get's JSON", leaked.length === 0, `${passwords.length} passwords, ${outputs.length} outputs checked`);
  writeFileSync(join(out, "git-proof.json"), `${JSON.stringify(records, null, 2)}\n`);
  return records;
}
