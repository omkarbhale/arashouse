// Code-tree deployment from the CLI (ticket 40, docs/code-deploy.md): `get --code` and `deploy-code`. A source (a
// folder or a zip, a WSL or Windows path) is read and planned before anything else happens, so a refused deploy
// costs no lease; then it is staged into `<root>\staging\<lease_id>\code\<n>` (the worker may change `staging\`,
// ticket 21), the broker's `deployCode` applies it, the lease record gets the deploy's file count and manifest hash
// (never a file's contents), and the staged copy is removed, whatever happened.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEPLOY_MANIFEST,
  MAX_DEPLOY_MANIFEST_BYTES,
  checkRelativePath,
  codeRecord,
  deployDigest,
  parseCodeRecord,
  parseCodeSpec,
  planDeploy,
  readDeployManifest,
  type CodeSpec,
  type DeployManifest,
  type DeployPlan,
  type DeployedFile,
} from "../core/code-deploy.js";
import { GuardError } from "../core/guards.js";
import { DEFAULT_INSTALL_ROOT, parseSlotId, stagingDir } from "../core/names.js";
import { redact } from "../core/redact.js";
import type { StateStore } from "../core/store.js";
import { ZipError, extractZipEntry, listZip, type ZipEntry, type ZipListing } from "../core/zip.js";
import type { HostDriver } from "../host/driver.js";
import { isHostError } from "../host/errors.js";
import { wslPathOf } from "./setup.js";

/** The install root as this process opens it; the default is its WSL path (`/mnt/c/aras_installations`). Tests map it to a folder. */
export const LOCAL_ROOT_ENV = "ARASHOUSE_LOCAL_ROOT";

export function localInstallRoot(env: NodeJS.ProcessEnv): string {
  return env[LOCAL_ROOT_ENV]?.trim() || wslPathOf(DEFAULT_INSTALL_ROOT);
}

export interface CodeRules {
  readonly allowConfig: boolean;
  readonly allowServers: boolean;
}

/** A source read and planned: what it holds, and what deploying it would do. */
export interface PlannedSource {
  readonly spec: CodeSpec;
  /** The source as this process opens it. */
  readonly local: string;
  readonly kind: "dir" | "zip";
  readonly plan: DeployPlan;
  /** The bytes of its `deploy.json`, staged with the files so the broker plans the same deploy. */
  readonly manifestBytes?: Uint8Array;
  readonly zip?: ZipListing;
}

function refuse(subject: string, detail: string): GuardError {
  return new GuardError("bad-path", "path", subject.slice(0, 200), detail);
}

/** The local path of a source: a Windows drive path through its WSL mount, anything else from the working folder. */
export function localSourcePath(source: string, cwd: string = process.cwd()): string {
  return /^[A-Za-z]:[\\/]/.test(source) ? wslPathOf(source) : resolve(cwd, source);
}

/** Every plain file under `dir`, relative and `/`-separated; a symbolic link (a junction, seen from WSL) or a device is refused. */
async function walkSource(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (folder: string, rel: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const info = await lstat(join(folder, entry.name));
      if (info.isSymbolicLink()) throw refuse(path, "the source has a symbolic link or junction; a deploy copies plain files only");
      if (info.isDirectory()) await walk(join(folder, entry.name), path);
      else if (info.isFile()) files.push(checkRelativePath("a source file", path));
      else throw refuse(path, "the source has something that is neither a file nor a folder");
    }
  };
  await walk(dir, "");
  return files;
}

/** The file entries of a zip, each name checked; a zip without its central directory is refused. */
function zipFiles(listing: ZipListing, source: string): string[] {
  if (!listing.centralDirectory) throw refuse(source, `the zip is damaged (${listing.damage ?? "no central directory"})`);
  return listing.entries.filter((e) => !e.name.endsWith("/")).map((e) => checkRelativePath("a zip entry", e.name));
}

function zipEntry(listing: ZipListing, path: string): ZipEntry {
  const entry = listing.entries.find((e) => !e.name.endsWith("/") && e.name.replace(/\\/g, "/") === path);
  if (entry === undefined) throw new ZipError(`${path} is not in ${listing.path}`);
  return entry;
}

async function readManifest(source: { kind: "dir"; local: string; files: string[] } | { kind: "zip"; listing: ZipListing; files: string[] }): Promise<{ manifest?: DeployManifest; bytes?: Uint8Array }> {
  const name = source.files.find((f) => f.toLowerCase() === DEPLOY_MANIFEST);
  if (name === undefined) return {};
  let bytes: Uint8Array;
  if (source.kind === "dir") {
    const info = await lstat(join(source.local, name));
    if (info.size > MAX_DEPLOY_MANIFEST_BYTES) throw refuse(DEPLOY_MANIFEST, `is larger than ${MAX_DEPLOY_MANIFEST_BYTES} bytes`);
    bytes = new Uint8Array(await readFile(join(source.local, name)));
  } else {
    const entry = zipEntry(source.listing, name);
    if (entry.uncompressedSize > MAX_DEPLOY_MANIFEST_BYTES) throw refuse(DEPLOY_MANIFEST, `is larger than ${MAX_DEPLOY_MANIFEST_BYTES} bytes`);
    const scratch = await mkdtemp(join(tmpdir(), "arashouse-deploy-"));
    try {
      const file = join(scratch, DEPLOY_MANIFEST);
      await extractZipEntry(source.listing.path, entry, file);
      bytes = new Uint8Array(await readFile(file));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return { manifest: readDeployManifest(bytes), bytes };
}

/** Reads and plans one `--code` argument. Throws a `GuardError` (exit 7) for a deploy the rules refuse, before anything is staged. */
export async function planSource(text: string, rules: CodeRules, cwd?: string): Promise<PlannedSource> {
  const spec = parseCodeSpec(text);
  const local = localSourcePath(spec.source, cwd);
  let info;
  try {
    info = await lstat(local);
  } catch {
    throw refuse(spec.source, "the source does not exist");
  }
  if (info.isSymbolicLink()) throw refuse(spec.source, "the source is a symbolic link or junction");
  const deployRules = { subpath: spec.subpath, allowConfig: rules.allowConfig, allowServers: rules.allowServers };
  if (info.isDirectory()) {
    const files = await walkSource(local);
    const { manifest, bytes } = await readManifest({ kind: "dir", local, files });
    return { spec, local, kind: "dir", plan: planDeploy(files, deployRules, manifest), ...(bytes ? { manifestBytes: bytes } : {}) };
  }
  if (!info.isFile() || !/\.zip$/i.test(local)) throw refuse(spec.source, "a source is a folder or a .zip");
  let listing: ZipListing;
  try {
    listing = await listZip(local);
  } catch (err) {
    throw refuse(spec.source, err instanceof Error ? err.message : String(err));
  }
  const files = zipFiles(listing, spec.source);
  const { manifest, bytes } = await readManifest({ kind: "zip", listing, files });
  return { spec, local, kind: "zip", plan: planDeploy(files, deployRules, manifest), zip: listing, ...(bytes ? { manifestBytes: bytes } : {}) };
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform: (chunk: Buffer, _e, done) => (hash.update(chunk), done()) }));
  return hash.digest("hex");
}

/** Copies the planned files of `source` (and its `deploy.json`) into the new folder `staged`; answers each one's target and hash. */
export async function stageSource(source: PlannedSource, staged: string): Promise<DeployedFile[]> {
  await mkdir(dirname(staged), { recursive: true });
  await mkdir(staged);
  const out: DeployedFile[] = [];
  for (const { source: rel, target } of source.plan.copies) {
    const to = join(staged, ...rel.split("/"));
    await mkdir(dirname(to), { recursive: true });
    if (source.kind === "zip") await extractZipEntry(source.local, zipEntry(source.zip as ZipListing, rel), to);
    else await pipeline(createReadStream(join(source.local, ...rel.split("/"))), createWriteStream(to, { flags: "wx" }));
    out.push({ target, sha256: await sha256Of(to) });
  }
  if (source.manifestBytes) await writeFile(join(staged, DEPLOY_MANIFEST), source.manifestBytes, { flag: "wx" });
  return out;
}

/** What one deploy did, as `get --code` and `deploy-code` report it (docs/schemas/deploy-code.schema.json). */
export interface CodeOutcome {
  readonly source: string;
  /** Where it landed in the slot's tree, `/`-separated ("" for the top). */
  readonly subpath: string;
  /** The files are in place and the slot came back up. */
  readonly ok: boolean;
  readonly files: number;
  readonly deleted: number;
  readonly detail: string;
}

export interface CodeDeployDeps {
  readonly store: StateStore;
  readonly host: Pick<HostDriver, "deployCode">;
  /** The local path of the install root, where `staging\` is (`localInstallRoot`). */
  readonly localRoot: string;
  /** The install root as the host names it; defaults to `DEFAULT_INSTALL_ROOT`. */
  readonly root?: string;
}

export interface CodeTarget {
  readonly slot: string;
  readonly leaseId: string;
  /** Start the agent again after each deploy (the lease was taken with `--agent`). */
  readonly agent: boolean;
}

export interface CodeDeployReport {
  readonly outcomes: readonly CodeOutcome[];
  /** Whether every deploy ran and left the slot up. */
  readonly ok: boolean;
  /** The error that stopped the deploys, when one did. */
  readonly error?: unknown;
}

/** The next free `staging\<lease_id>\code\<n>` number. */
async function nextIndex(codeDir: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(codeDir);
  } catch {
    names = [];
  }
  return Math.max(0, ...names.filter((n) => /^\d{1,4}$/.test(n)).map(Number)) + 1;
}

/** Records one more deploy in the lease's bootstrap record: the files and the chained manifest hash, no contents. */
async function record(store: StateStore, target: CodeTarget, files: number, digest: string): Promise<void> {
  await store.update((tx) => {
    const bootstrap = tx.slot(target.slot)?.lease?.bootstrap ?? {};
    const next = codeRecord(parseCodeRecord(bootstrap.code), files, digest);
    const count = typeof bootstrap.code_deploys === "number" ? bootstrap.code_deploys : 0;
    tx.recordBootstrap(target.slot, target.leaseId, { code: next.text, code_deploys: count + 1 });
  });
}

/**
 * Deploys `sources` onto the lease's slot in order, each staged, deployed, recorded and unstaged; it stops at the first
 * that fails or leaves the slot down. Never throws for a deploy's failure: the report carries it.
 */
export async function deployCodeOnLease(deps: CodeDeployDeps, target: CodeTarget, sources: readonly PlannedSource[], rules: CodeRules): Promise<CodeDeployReport> {
  const root = deps.root ?? DEFAULT_INSTALL_ROOT;
  const ref = parseSlotId(target.slot);
  const leaseLocal = join(deps.localRoot, "staging", target.leaseId);
  const codeLocal = join(leaseLocal, "code");
  const outcomes: CodeOutcome[] = [];
  for (const source of sources) {
    const n = await nextIndex(codeLocal);
    const stagedLocal = join(codeLocal, String(n));
    const stagedWin = win32.join(stagingDir(target.leaseId, root), "code", String(n));
    const base = { source: source.spec.source, subpath: source.spec.subpath };
    try {
      const staged = await stageSource(source, stagedLocal);
      const result = await deps.host.deployCode(ref, stagedWin, {
        leaseId: target.leaseId,
        subpath: source.spec.subpath,
        allowConfig: rules.allowConfig,
        allowServers: rules.allowServers,
        agent: target.agent,
      });
      await record(deps.store, target, result.files, deployDigest(staged, source.plan.deletes));
      outcomes.push({ ...base, ok: result.ok, files: result.files, deleted: result.deleted, detail: redact(result.detail) });
      if (!result.ok) return { outcomes, ok: false };
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      outcomes.push({ ...base, ok: false, files: 0, deleted: 0, detail: message });
      return { outcomes, ok: false, error: err };
    } finally {
      await rm(stagedLocal, { recursive: true, force: true }).catch(() => undefined);
      for (const dir of [codeLocal, leaseLocal]) await rmdir(dir).catch(() => undefined);
    }
  }
  return { outcomes, ok: true };
}

/** Whether the deploy failed because a guard refused it (nothing was changed): exit 7 rather than 9. */
export function refusedDeploy(report: CodeDeployReport): boolean {
  return report.error instanceof GuardError || isHostError(report.error, "Refused");
}

/** One line per deploy, for the human output. */
export function formatOutcomes(outcomes: readonly CodeOutcome[]): string[] {
  return outcomes.map((o) => `code:      ${o.source} -> ${o.subpath === "" ? "." : o.subpath}: ${o.ok ? `${o.files} files` : "failed"} (${o.detail})`);
}
