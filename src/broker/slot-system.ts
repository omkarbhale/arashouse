// The `SlotSystem` on the host (provision.ts): Node's own fs where it does, and one
// `slot-steps.ps1 -Step <name>` process for each operation that needs IIS, the agent service, SQL
// Server, robocopy, icacls or DPAPI (slot-steps.ts). The broker writes the script from its own code
// to `<root>\broker\slot-steps.ps1` (a folder only SYSTEM and the broker may change, ticket 21)
// whenever the file differs, then runs it.
//
// Secrets: the slot's SQL login passwords go only on the `database` step's stdin, and into the
// slot's rendered config files (edits.ts); a stored secret only on a secret step's stdin or stdout.

import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ManifestError, summarizeDiff } from "../core/manifest.js";
import { buildScratch, goldenDir, slotDir, slotStepsScript, type SlotRef } from "../core/names.js";
import type { FlavorKey } from "../core/flavors.js";
import { anonymousGet } from "../host/http.js";
import { dpapiSecretStore } from "./dpapi-store.js";
import type { BrokerFs } from "./fs.js";
import { readManifest, verifyGolden, verifyTree } from "./manifest-fs.js";
import type { GoldenCheck, SlotLogins, SlotSystem, TreeReset } from "./provision.js";
import { runPsScript } from "./ps-step.js";
import type { DatabaseMarker, DatabaseReset } from "./reset-database.js";
import { renderSlotStepsScript, type SlotStep } from "./slot-steps.js";

/** How long one step may take: the mirror copies a golden tree, the rest take seconds. */
const STEP_TIMEOUT_MS: Readonly<Partial<Record<SlotStep, number>>> = { mirror: 20 * 60_000, "reset-tree": 20 * 60_000 };
const DEFAULT_STEP_TIMEOUT_MS = 5 * 60_000;

export interface WindowsSlotSystemOptions {
  readonly root: string;
  readonly fs: BrokerFs;
  /** Told each step's stderr line (redacted). */
  readonly onLog?: (line: string) => void;
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function windowsSlotSystem(options: WindowsSlotSystemOptions): SlotSystem {
  const local = (path: string) => options.fs.localPath(path);
  const script = slotStepsScript(options.root);
  // CRLF and ASCII, as Windows PowerShell 5.1 reads a script without a BOM.
  const text = renderSlotStepsScript(options.root).replace(/\n/g, "\r\n");

  const ensureScript = async (): Promise<void> => {
    let current: string | null = null;
    try {
      current = await readFile(local(script), "latin1");
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (current !== text) await writeFile(local(script), text, "latin1");
  };
  const step = async (name: SlotStep, request: object): Promise<Record<string, unknown>> => {
    await ensureScript();
    return runPsScript(script, name, request, { timeoutMs: STEP_TIMEOUT_MS[name] ?? DEFAULT_STEP_TIMEOUT_MS, onLog: options.onLog });
  };
  const slotStep = (name: SlotStep, slot: SlotRef, extra: object = {}) => step(name, { flavor: slot.flavor, slot: slot.slot, ...extra });

  return {
    now: () => Date.now(),
    async golden(flavor: FlavorKey): Promise<GoldenCheck> {
      if (await exists(local(buildScratch(flavor, options.root).promotingMarker))) return { state: "promoting" };
      const dir = local(goldenDir(flavor, options.root));
      try {
        const diff = await verifyGolden(dir, flavor, { level: "golden" });
        if (!diff.ok) return { state: "unusable", detail: `it does not verify: ${summarizeDiff(diff)}` };
        return { state: "ok", hash: (await readManifest(join(dir, "manifest.json"))).manifestHash };
      } catch (err) {
        if (isMissing(err)) return { state: "unusable", detail: "it is not built" };
        if (err instanceof ManifestError) return { state: "unusable", detail: `its manifest is unusable: ${err.message}` };
        throw err;
      }
    },
    async snapshotDenyList() {
      const prints = (await step("snapshot", {})).prints;
      if (typeof prints !== "object" || prints === null || Array.isArray(prints)) throw new Error("snapshot answered no fingerprints");
      return Object.fromEntries(Object.entries(prints as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    },
    async present(slot) {
      return strings((await slotStep("present", slot)).present);
    },
    async makeFolders(slot) {
      await slotStep("folders", slot);
    },
    async mirrorTree(slot) {
      await slotStep("mirror", slot);
    },
    async createIis(slot) {
      return Number((await slotStep("iis", slot)).applications);
    },
    async createAgent(slot) {
      const r = await slotStep("agent", slot);
      return r.installed === true ? { installed: true, port: Number(r.port) } : { installed: false };
    },
    async restoreDatabase(slot, logins: SlotLogins) {
      await slotStep("database", slot, { secrets: { dbo: logins.dbo.reveal(), reg: logins.reg.reveal() } });
    },
    async start(slot, { agent }) {
      const r = await slotStep("start", slot, { agent });
      const state = r.agent === "running" || r.agent === "none" ? r.agent : "not asked";
      return { pools: Number(r.pools), agent: state, port: Number(r.port) };
    },
    async resetDatabase(slot, marker: DatabaseMarker): Promise<DatabaseReset> {
      const r = await slotStep("reset-database", slot, { marker });
      if (r.missing === true) return { state: "missing" };
      const texts = (v: unknown): Record<string, string> =>
        typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : {};
      return { state: "restored", restoreMs: Number(r.restoreMs), killed: Number(r.killed), access: String(r.access), marker: texts(r.marker), version: texts(r.version) };
    },
    async stop(slot) {
      const r = await slotStep("stop", slot);
      return { pools: Number(r.pools), agent: r.agent === "stopped" ? "stopped" : "none" };
    },
    warm: (url, timeoutMs) => anonymousGet(url, { timeoutMs }),
    async quiesce(slot) {
      return (await slotStep("quiesce", slot)).provisioned === true;
    },
    async resetTree(slot): Promise<TreeReset> {
      const r = await slotStep("reset-tree", slot);
      if (r.provisioned !== true) return { state: "not-provisioned" };
      if (r.quiesced !== true) return { state: "serving", serving: strings(r.serving) };
      return {
        state: "reset",
        mirrorMs: Number(r.mirrorMs),
        clearMs: Number(r.clearMs),
        runtimeEntries: Number(r.runtimeEntries),
        vaultEntries: Number(r.vaultEntries),
        aspnetFolders: Number(r.aspnetFolders),
      };
    },
    verifyTree: (slot, manifest, rendered) => verifyTree(local(slotDir(slot, options.root)), manifest, { level: "fast", rendered }),
    async removeAgent(slot) {
      return (await slotStep("remove-agent", slot)).removed === true;
    },
    async removeDatabase(slot) {
      const dropped = (await slotStep("remove-database", slot)).dropped;
      if (typeof dropped !== "object" || dropped === null) throw new Error("remove-database answered nothing");
      return Object.fromEntries(Object.entries(dropped as Record<string, unknown>).map(([k, v]) => [k, Number(v)]));
    },
    async removeIis(slot) {
      await slotStep("remove-iis", slot);
    },
    isDirectory: (path) => options.fs.isDirectory(path),
    async readFile(path) {
      try {
        return new Uint8Array(await readFile(local(path)));
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    async writeFile(path, data) {
      await mkdir(dirname(local(path)), { recursive: true });
      await writeFile(local(path), data);
    },
    removeDir: (path) => rm(local(path), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
    async removeEmptyDir(path) {
      try {
        await rmdir(local(path));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
      }
    },
    secrets: dpapiSecretStore((name, request) => step(name, request)),
  };
}
