// The baseline build's `BuildSystem` on the host: Node's own fs and fetch where they do, and one
// `baseline-steps.ps1 -Step <name>` process for each operation that needs Windows Installer, IIS,
// SQL Server, robocopy or icacls (baseline-steps.ts). It runs in the captain's elevated session.
//
// Secrets: the build's SQL login passwords go only on the `database` step's stdin; the admin password
// only into the OAuth request body, as its MD5 (as the Aras clients send it). Neither is in an
// argument list, an environment, a log or the report.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import type { BaselinePlan, DenyListSnapshot, IisApplication } from "../core/baseline.js";
import { setupRecordFile } from "../core/names.js";
import { redact } from "../core/redact.js";
import type { Secret } from "../core/secret.js";
import { anonymousGet } from "../host/http.js";
import type { BuildLogins, BuildSystem, CopyResult } from "./baseline-build.js";
import { RESULT_MARKER, type PsStep } from "./baseline-steps.js";
import { buildManifest, writeManifestOnce } from "./manifest-fs.js";

/** How long a step may take: the MSI took 126 to 642 s in the spike; the rest are seconds to minutes. */
const STEP_TIMEOUT_MS: Readonly<Partial<Record<PsStep, number>>> = { install: 30 * 60_000, remove: 20 * 60_000, "copy-tree": 20 * 60_000 };
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 120_000;

export interface WindowsBuildSystemOptions {
  /** `baseline-steps.ps1` in the bundle. */
  readonly stepsScript: string;
  /** Told each step's stderr line (redacted), for the console. */
  readonly onLog?: (line: string) => void;
}

/** One step: the request on stdin, the marked result line from stdout; a non-zero exit is the step's error line. */
export function runPsStep(script: string, step: PsStep, request: object, onLog?: (line: string) => void): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Step", step], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), STEP_TIMEOUT_MS[step] ?? DEFAULT_STEP_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      err += d;
      for (const line of d.split(/\r?\n/)) if (line.trim()) onLog?.(redact(line.trim()));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.startsWith(RESULT_MARKER));
      if (code !== 0 || line === undefined) {
        const why = err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(" / ");
        reject(new Error(redact(`${step} failed (exit ${code ?? "killed"})${why ? `: ${why}` : ""}`)));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(RESULT_MARKER.length)) as Record<string, unknown>);
      } catch {
        reject(new Error(`${step} answered something that is not JSON`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** An OAuth password grant against the build's own OAuth server; true when it answers a token. */
async function passwordGrant(alias: string, database: string, user: string, password: Secret): Promise<{ ok: boolean; detail: string }> {
  const md5 = createHash("md5").update(password.reveal(), "utf8").digest("hex");
  const body = new URLSearchParams({ grant_type: "password", scope: "Innovator", client_id: "IOMApp", username: user, password: md5, database });
  try {
    const res = await fetch(`http://localhost/${alias}/OAuthServer/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: { access_token?: unknown; error?: unknown; error_description?: unknown } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // Not JSON: reported by status below.
    }
    if (res.ok && typeof json.access_token === "string" && json.access_token.length > 0) return { ok: true, detail: "token issued" };
    // The server's refusal names the cause (a missing licence, a wrong password), never the password.
    const why = typeof json.error === "string" ? `${json.error}${typeof json.error_description === "string" ? `: ${json.error_description}` : ""}` : `HTTP ${res.status}`;
    return { ok: false, detail: redact(why).slice(0, 300) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error && err.name === "TimeoutError" ? `no answer in ${HTTP_TIMEOUT_MS / 1000} s` : "connection failed" };
  }
}

export function windowsBuildSystem(plan: BaselinePlan, options: WindowsBuildSystemOptions): BuildSystem {
  const step = (name: PsStep, extra: object = {}) => runPsStep(options.stepsScript, name, { flavor: plan.flavor, ...extra }, options.onLog);
  return {
    now: () => Date.now(),
    async missingPrerequisites() {
      let text: string;
      try {
        text = await readFile(setupRecordFile(plan.root), "utf8");
      } catch {
        return null;
      }
      const record = JSON.parse(text.replace(/^﻿/, "")) as { prerequisites?: { missing?: { id?: unknown }[] } };
      return (record.prerequisites?.missing ?? []).map((m) => String(m.id));
    },
    async freeDiskGb() {
      const info = await statfs(plan.root);
      return Math.floor(((info.bavail * info.bsize) / 1024 ** 3) * 10) / 10;
    },
    exists,
    sha256: sha256File,
    async survey() {
      return strings((await step("survey")).present);
    },
    async snapshotDenyList() {
      const prints = (await step("snapshot")).prints;
      if (typeof prints !== "object" || prints === null || Array.isArray(prints)) throw new Error("snapshot answered no fingerprints");
      return Object.fromEntries(Object.entries(prints as Record<string, unknown>).map(([k, v]) => [k, String(v)])) as DenyListSnapshot;
    },
    async copyMsi() {
      const msi = (await step("msi-copy")).msi;
      if (typeof msi !== "string") throw new Error("msi-copy answered no path");
      return msi;
    },
    async costMsi() {
      return strings((await step("msi-cost")).outside);
    },
    async installMsi() {
      const r = await step("install");
      const errors = strings(r.errors);
      return { exitCode: Number(r.exitCode), failedActions: [...strings(r.failedActions), ...errors.map((e) => `Error ${e}`)] };
    },
    async ownPools() {
      const apps = (await step("pools")).applications;
      return (Array.isArray(apps) ? apps : []) as IisApplication[];
    },
    async restoreDatabase(_plan, logins: BuildLogins) {
      await step("database", { secrets: { dbo: logins.dbo.reveal(), reg: logins.reg.reveal() } });
    },
    readFile: async (path) => new Uint8Array(await readFile(path)),
    async writeFile(path, data) {
      await mkdir(win32.dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    get: (url, readBody) => anonymousGet(url, { timeoutMs: HTTP_TIMEOUT_MS, readBody }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    login: (p, user, password) => passwordGrant(p.names.alias, p.names.database, user, password),
    async serverVersion() {
      const v = (await step("server-version")).version;
      return typeof v === "string" && v.length > 0 ? v : null;
    },
    async stopPools() {
      await step("stop");
    },
    async copyTree(): Promise<CopyResult> {
      const r = await step("copy-tree");
      return { files: Number(r.files), bytes: Number(r.bytes) };
    },
    async copyFile(from, to) {
      await mkdir(win32.dirname(to), { recursive: true });
      await copyFile(from, to);
    },
    async backupDatabase() {
      await step("backup");
    },
    fileSize: async (path) => (await stat(path)).size,
    removeFile: (path) => rm(path, { force: true }),
    removeDir: (path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
    rename: (from, to) => rename(from, to),
    buildManifest: (p, tree, serverBuild) => buildManifest(tree, p.flavor, serverBuild),
    writeManifest: (file, manifest) => writeManifestOnce(file, manifest),
    async removeThrowaway() {
      return strings((await step("remove")).left);
    },
    async seal() {
      await step("seal");
    },
  };
}
