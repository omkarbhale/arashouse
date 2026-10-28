// The git baseline of a leased slot's code tree from the CLI (ticket 53, docs/git-baseline.md): `get --git` and
// `git-baseline`. The repository's first commit is the slot's `Innovator\` tree exactly as handed over (after the
// restore, the code deploys and the imports), so `git status` and `git diff` show only what the holder changed.
//
// git runs as the worker, never as the broker: on the host it is Git for Windows through interop (reading the tree
// through `/mnt/c` takes minutes; git.exe reads it natively, with the worker's read grant on `slots\`). It makes the
// repository in `<root>\staging\<lease_id>\code\<n>` with the slot's `Innovator\` as its work tree: the generated
// `.gitignore` (src/core/git-baseline.ts), one commit by a fixed identity, the objects in one pack. Then the broker's
// `deployCode` (ticket 40) puts `.git\` and `.gitignore` into `Innovator\`, with the guards it has for anything the
// worker stages. The lease record gets `git: <commit>`. The reset's mirror removes both (ticket 30).

import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import {
  GIT_BRANCH,
  GIT_DIR_NAME,
  GIT_IDENTITY,
  GIT_IGNORE_NAME,
  GIT_REPO_CONFIG,
  GIT_REPO_SUBPATH,
  assertNothingSecretStaged,
  baselineMessage,
  isCommitId,
  isGitTarget,
  renderGitignore,
} from "../core/git-baseline.js";
import type { FlavorKey } from "../core/flavors.js";
import { GuardError } from "../core/guards.js";
import { DEFAULT_INSTALL_ROOT, parseSlotId, slotDir, stagingDir } from "../core/names.js";
import { redact } from "../core/redact.js";
import type { StateStore } from "../core/store.js";
import type { HostDriver } from "../host/driver.js";
import { isHostError } from "../host/errors.js";
import { nextIndex, type PlannedSource } from "./code.js";

/** Where Git for Windows is, as WSL runs it; `ARASHOUSE_WINDOWS_GIT` overrides it. */
export const DEFAULT_WINDOWS_GIT = "/mnt/c/Program Files/Git/cmd/git.exe";
export const WINDOWS_GIT_ENV = "ARASHOUSE_WINDOWS_GIT";
/** The git the fake host's baseline runs (the tests'): `git` on the PATH unless `ARASHOUSE_GIT` names one. */
export const GIT_ENV = "ARASHOUSE_GIT";

/** How one git is run: the program, the path it is given for a Windows path under the root, and its environment. */
export interface GitTool {
  readonly exe: string;
  readonly path: (windowsPath: string) => string;
  /** Added to the environment: no system or user config is read, so nothing of the worker's own git settings applies. */
  readonly env: NodeJS.ProcessEnv;
}

/** The variables that keep the worker's git config out, and across interop the list that carries them (`WSLENV`). */
function isolated(nullDevice: string, env: NodeJS.ProcessEnv, interop: boolean): NodeJS.ProcessEnv {
  const vars = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullDevice, GIT_TERMINAL_PROMPT: "0" };
  if (!interop) return vars;
  const carried = [env.WSLENV, ...Object.keys(vars)].filter((v) => v !== undefined && v !== "").join(":");
  return { ...vars, WSLENV: carried };
}

/** The local path of a Windows path under `root`, under `localRoot`. */
function localOf(root: string, localRoot: string, windowsPath: string): string {
  const prefix = `${root.toLowerCase()}\\`;
  if (!windowsPath.toLowerCase().startsWith(prefix)) throw new Error(`"${windowsPath}" is not under ${root}`);
  return join(localRoot, ...windowsPath.slice(prefix.length).split("\\").filter(Boolean));
}

/**
 * The git a baseline runs: on the host (the broker), Git for Windows given Windows paths; with the fake host, the local
 * git given the local paths, so the tests run the same commands on a tree under `localRoot`.
 */
export function selectGitTool(kind: "fake" | "broker", env: NodeJS.ProcessEnv, localRoot: string, root: string = DEFAULT_INSTALL_ROOT): GitTool {
  if (kind === "broker") return { exe: env[WINDOWS_GIT_ENV]?.trim() || DEFAULT_WINDOWS_GIT, path: (p) => p, env: isolated("NUL", env, true) };
  return { exe: env[GIT_ENV]?.trim() || "git", path: (p) => localOf(root, localRoot, p), env: isolated("/dev/null", env, false) };
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * WSL interop failing to start a Windows program on a busy host ("UtilAcceptVsock: accept4 failed 110"): git never ran,
 * so it is run again.
 */
const INTEROP_LAUNCH_FAILURE = /UtilAcceptVsock|accept4 failed/;
/** Tries after the first when interop could not start git, and the pause before each. */
export const INTEROP_RETRIES = 3;
const INTEROP_RETRY_MS = 2_000;

/** Runs git; its stdout, or a `GitError` with the command's name and git's first lines (redacted). */
async function runGit(tool: GitTool, args: readonly string[], baseEnv: NodeJS.ProcessEnv, retryMs: number = INTEROP_RETRY_MS): Promise<string> {
  const once = () =>
    new Promise<{ ok: true; stdout: string } | { ok: false; why: string }>((resolve) => {
      execFile(tool.exe, args, { env: { ...baseEnv, ...tool.env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error === null) resolve({ ok: true, stdout });
        else resolve({ ok: false, why: (stderr || error.message).trim().split(/\r?\n/).slice(0, 3).join("; ") });
      });
    });
  let result = await once();
  for (let retry = 1; retry <= INTEROP_RETRIES && !result.ok && INTEROP_LAUNCH_FAILURE.test(result.why); retry++) {
    await new Promise((r) => setTimeout(r, retryMs * retry));
    result = await once();
  }
  if (result.ok) return result.stdout;
  const what = args.find((a) => !a.startsWith("-")) ?? "git";
  throw new GitError(redact(`git ${what} failed: ${result.why}`).slice(0, 600));
}

/** Whether git can be run at all; checked before `get --git` takes a lease. */
export async function checkGitTool(tool: GitTool, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runGit(tool, ["--version"], env);
  } catch {
    throw new GitError(`git could not be run (${tool.exe}); install Git for Windows, or set ${WINDOWS_GIT_ENV} to its git.exe as WSL sees it`);
  }
}

/** `--code` sources that would write the repository's place: refused with `--git`, before the lease is taken. */
export function assertNoGitTargets(sources: readonly PlannedSource[]): void {
  for (const source of sources) {
    const hit = source.plan.copies.find((c) => isGitTarget(c.target))?.target ?? source.plan.deletes.find(isGitTarget);
    if (hit !== undefined) throw new GuardError("bad-path", "path", hit, `--code ${source.spec.source} writes ${hit}, which the git baseline makes`);
  }
}

/** Every file under `dir`, made writable: git leaves its pack read-only, and the staged folder is removed after the deploy. */
async function makeWritable(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await makeWritable(path);
    else if (entry.isFile()) await chmod(path, 0o644);
  }
}

export interface GitTarget {
  readonly slot: string;
  readonly leaseId: string;
  readonly flavor: FlavorKey;
  /** Start the agent again after the deploy (the lease was taken with `--agent`). */
  readonly agent: boolean;
}

export interface GitDeps {
  readonly store: StateStore;
  readonly host: Pick<HostDriver, "deployCode">;
  readonly git: GitTool;
  /** The local path of the install root, where `staging\` and `slots\` are (`localInstallRoot`). */
  readonly localRoot: string;
  /** The install root as the host names it; defaults to `DEFAULT_INSTALL_ROOT`. */
  readonly root?: string;
  /** The environment git runs in, before the tool's own variables. */
  readonly env: NodeJS.ProcessEnv;
}

/** What a baseline did, as `get --git` and `git-baseline` report it (docs/schemas/git-baseline.schema.json). */
export interface GitOutcome {
  /** The repository is in the slot's tree and the slot came back up. */
  readonly ok: boolean;
  /** The commit, once one was made. */
  readonly commit: string | null;
  /** Files the commit holds. */
  readonly files: number;
  /** The repository's work tree, as a Windows path. */
  readonly path: string;
  readonly detail: string;
}

export interface GitReport {
  readonly outcome: GitOutcome;
  /** The error that stopped the baseline, when one did. */
  readonly error?: unknown;
}

/** Builds the repository in `staged` (Windows path) over the work tree `worktree`; answers the commit and its file count. */
async function buildRepository(deps: GitDeps, target: GitTarget, staged: string, worktree: string): Promise<{ commit: string; files: number }> {
  const { git } = deps;
  const run = (args: readonly string[]) => runGit(git, args, deps.env);
  const gitDir = git.path(win32.join(staged, GIT_DIR_NAME));
  const ignoreFile = git.path(win32.join(staged, GIT_IGNORE_NAME));
  const repo = [`--git-dir=${gitDir}`, `--work-tree=${git.path(worktree)}`];
  // No template: no sample hooks, no description. The repository's settings before anything is read.
  await run(["init", "--quiet", "--template=", `--initial-branch=${GIT_BRANCH}`, git.path(staged)]);
  for (const [key, value] of GIT_REPO_CONFIG) await run([`--git-dir=${gitDir}`, "config", key, value]);
  // The work tree has no .gitignore yet: the staged one is read as the excludes file, which matches from the top as it will.
  await run([...repo, "-c", `core.excludesFile=${ignoreFile}`, "add", "--all"]);
  const blob = (await run([`--git-dir=${gitDir}`, "hash-object", "-w", ignoreFile])).trim();
  await run([`--git-dir=${gitDir}`, "update-index", "--add", "--cacheinfo", `100644,${blob},${GIT_IGNORE_NAME}`]);
  const tracked = (await run([`--git-dir=${gitDir}`, "ls-files", "-z"])).split("\0").filter(Boolean);
  assertNothingSecretStaged(target.flavor, tracked);
  await run([...repo, "-c", `user.name=${GIT_IDENTITY.name}`, "-c", `user.email=${GIT_IDENTITY.email}`, "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", baselineMessage(target.flavor, target.leaseId)]);
  const commit = (await run([`--git-dir=${gitDir}`, "rev-parse", "HEAD"])).trim();
  if (!isCommitId(commit)) throw new GitError(`git rev-parse answered no commit id`);
  // One pack, no deltas (seconds, not a minute): a few files for the broker to copy instead of one per object.
  await run([`--git-dir=${gitDir}`, "repack", "-a", "-d", "-n", "--quiet", "--window=0", "--depth=0"]);
  await run([`--git-dir=${gitDir}`, "prune-packed", "--quiet"]);
  return { commit, files: tracked.length };
}

/**
 * Makes the lease's git baseline: the repository built and staged, deployed into the slot's `Innovator\`, recorded on
 * the lease, unstaged. Never throws for the baseline's failure: the report carries it.
 */
export async function gitBaselineOnLease(deps: GitDeps, target: GitTarget): Promise<GitReport> {
  const root = deps.root ?? DEFAULT_INSTALL_ROOT;
  const ref = parseSlotId(target.slot);
  const worktree = win32.join(slotDir(ref, root), GIT_REPO_SUBPATH);
  const leaseLocal = join(deps.localRoot, "staging", target.leaseId);
  const codeLocal = join(leaseLocal, "code");
  let commit: string | null = null;
  let files = 0;
  const fail = (err: unknown): GitReport => ({
    outcome: { ok: false, commit, files, path: worktree, detail: redact(err instanceof Error ? err.message : String(err)) },
    error: err,
  });
  const existing = (await leaseBootstrap(deps.store, target))?.git;
  if (existing !== undefined) return fail(new GuardError("bad-path", "path", worktree, `the lease already has a git baseline (${String(existing)})`));
  for (const name of [GIT_DIR_NAME, GIT_IGNORE_NAME]) {
    const present = await lstat(join(localOf(root, deps.localRoot, worktree), name)).then(() => true, () => false);
    if (present) return fail(new GuardError("bad-path", "path", `${worktree}\\${name}`, `the slot's tree already has ${GIT_REPO_SUBPATH}\\${name}; the git baseline makes its own`));
  }
  const n = await nextIndex(codeLocal);
  const stagedLocal = join(codeLocal, String(n));
  const stagedWin = win32.join(stagingDir(target.leaseId, root), "code", String(n));
  const started = Date.now();
  try {
    await mkdir(stagedLocal, { recursive: true });
    await writeFile(join(stagedLocal, GIT_IGNORE_NAME), renderGitignore(target.flavor), { flag: "wx" });
    ({ commit, files } = await buildRepository(deps, target, stagedWin, worktree));
    const built = Date.now() - started;
    await makeWritable(stagedLocal);
    const result = await deps.host.deployCode(ref, stagedWin, { leaseId: target.leaseId, subpath: GIT_REPO_SUBPATH, allowConfig: false, allowServers: false, agent: target.agent });
    await deps.store.update((tx) => {
      tx.recordBootstrap(target.slot, target.leaseId, { git: commit });
    });
    const detail = `commit ${commit} of ${files} files, built in ${(built / 1000).toFixed(1)} s; ${redact(result.detail)}`;
    return { outcome: { ok: result.ok, commit, files, path: worktree, detail } };
  } catch (err) {
    return fail(err);
  } finally {
    await rm(stagedLocal, { recursive: true, force: true }).catch(() => undefined);
    for (const dir of [codeLocal, leaseLocal]) await rmdir(dir).catch(() => undefined);
  }
}

/** The lease's bootstrap record, when the slot still holds that lease. */
async function leaseBootstrap(store: StateStore, target: GitTarget) {
  const slot = (await store.read()).slots[target.slot];
  return slot?.lease?.lease_id === target.leaseId ? slot.lease.bootstrap : undefined;
}

/** Whether the baseline failed because a guard refused it (nothing was changed): exit 7 rather than 10. */
export function refusedBaseline(report: GitReport): boolean {
  return report.error instanceof GuardError || isHostError(report.error, "Refused");
}

/** The human line. */
export function formatGitOutcome(outcome: GitOutcome): string {
  return `git:       ${outcome.ok ? `${outcome.commit} in ${outcome.path}` : "failed"} (${outcome.detail})`;
}
