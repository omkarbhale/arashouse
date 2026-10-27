// The baseline build's `BuildSystem` on the host: Node's own fs and fetch where they do, and one
// `baseline-steps.ps1 -Step <name>` process for each operation that needs Windows Installer, IIS,
// SQL Server, robocopy or icacls (baseline-steps.ts). It runs in the captain's elevated session.
//
// Secrets: the build's SQL login passwords go only on the `database` step's stdin; the admin password
// only into the OAuth request body, as its MD5 (as the Aras clients send it), and on the engine check's
// stdin (`aras-pkg --password-stdin`). Neither is in an argument list, an environment, a log or the report.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { ENGINE_CHECK_ITEM, type BaselinePlan, type DenyListSnapshot, type IisApplication } from "../core/baseline.js";
import { setupRecordFile } from "../core/names.js";
import { redact } from "../core/redact.js";
import type { Secret } from "../core/secret.js";
import { anonymousGet } from "../host/http.js";
import type { BuildLogins, BuildSystem, CopyResult, EngineExport } from "./baseline-build.js";
import type { PsStep } from "./baseline-steps.js";
import { runPsScript } from "./ps-step.js";
import { buildManifest, writeManifestOnce } from "./manifest-fs.js";

/** How long a step may take: the MSI took 126 to 642 s in the spike; the rest are seconds to minutes. */
const STEP_TIMEOUT_MS: Readonly<Partial<Record<PsStep, number>>> = { install: 30 * 60_000, remove: 20 * 60_000, "copy-tree": 20 * 60_000 };
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 120_000;
/** The engine check exports one item: seconds, or a minute on a cold server. */
const ENGINE_TIMEOUT_MS = 10 * 60_000;

export interface WindowsBuildSystemOptions {
  /** `baseline-steps.ps1` in the bundle. */
  readonly stepsScript: string;
  /** Told each step's stderr line (redacted), for the console. */
  readonly onLog?: (line: string) => void;
  /** The bundled import-export-libs-js `dist\cli.js`, when the bundle carries one (`--engine-check`). */
  readonly engineCli?: string;
}

/** One step: the request on stdin, the marked result line from stdout; a non-zero exit is the step's error line. */
export function runPsStep(script: string, step: PsStep, request: object, onLog?: (line: string) => void): Promise<Record<string, unknown>> {
  return runPsScript(script, step, request, { timeoutMs: STEP_TIMEOUT_MS[step] ?? DEFAULT_STEP_TIMEOUT_MS, onLog });
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

/**
 * `aras-pkg export` of one item under this Node (Windows `node.exe`, where `localhost` is IIS: the server's OAuth
 * discovery names `http://localhost/...`, spike 07). The password goes on stdin; stdout is the `--json` summary.
 */
export function engineExport(cli: string, plan: BaselinePlan, user: string, password: Secret): Promise<EngineExport> {
  const out = plan.scratch.engineDir;
  const args = [cli, "export", win32.join(out, "pkg"), ENGINE_CHECK_ITEM, "--engine", plan.libsJsEngine, "--url", `http://localhost/${plan.names.alias}`];
  args.push("--database", plan.names.database, "--user", user, "--password-stdin", "--log", win32.join(out, "aras-pkg.log"), "--json");
  return new Promise((resolve, reject) => {
    mkdir(out, { recursive: true }).then(() => {
      const child = spawn(process.execPath, args, { cwd: out, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), ENGINE_TIMEOUT_MS);
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4096)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let summary: EngineExport["summary"] = null;
        try {
          const json = JSON.parse(stdout) as Record<string, unknown>;
          const str = (k: string) => (typeof json[k] === "string" ? (json[k] as string) : undefined);
          summary = {
            ...(str("result") ? { result: str("result") } : {}),
            ...(str("engine") ? { engine: str("engine") } : {}),
            ...(str("server") ? { server: str("server") } : {}),
            ...(typeof json.items === "number" ? { items: json.items } : {}),
            ...(str("error") ? { error: str("error") } : {}),
          };
        } catch {
          // No summary: reported by exit code.
        }
        const last = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
        resolve({ exitCode: code ?? -1, summary, ...(last ? { lastLine: redact(last).slice(0, 300) } : {}) });
      });
      child.stdin.end(`${password.reveal()}\n`);
    }, reject);
  });
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
    async engineExport(p, user, password) {
      if (!options.engineCli) throw new Error("the bundle carries no engine CLI (write it with --engine-check)");
      return engineExport(options.engineCli, p, user, password);
    },
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
