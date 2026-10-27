// A `SlotSystem` in memory, for the provision, destroy and reset tests: golden files from the sample
// configs (config-samples.fixture.ts) and a manifest of them, the slot's host objects by name, which
// slots are serving, a call record and one-shot faults. Paths are the Windows paths the verbs derive,
// compared without case, as Windows does (so the fake manifest's paths are lower-case).

import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { OOTB_OWNER, type DenyListSnapshot } from "../core/baseline.js";
import { sampleGolden } from "../core/config-samples.fixture.js";
import { serializeEditList } from "../core/edits.js";
import { editList } from "../core/edit-lists.js";
import { FLAVORS, FLAVOR_KEYS, type FlavorKey } from "../core/flavors.js";
import {
  compareTree,
  isRuntimePath,
  makeManifest,
  pathsToHash,
  serializeManifest,
  type Manifest,
  type ManifestDiff,
  type ObservedFile,
} from "../core/manifest.js";
import { DEFAULT_INSTALL_ROOT, agentPort, databaseName, goldenLayout, loginName, slotId, slotLoginSecretName, slotNames, type SlotRef } from "../core/names.js";
import type { Secret } from "../core/secret.js";
import { MemorySecretStore } from "../core/secret-store.js";
import type { GoldenCheck, SlotLogins, SlotSystem, StartInfo, StopInfo, TreeReset, WarmAnswer } from "./provision.js";

export const FAKE_GOLDEN_HASH = "9".repeat(64);

/** Every file of the fake has this last-write time. */
const MTIME = "2026-10-28T10:00:00.0000000Z";

/** Golden files beyond the configs: a client script, the server's main DLL, and runtime files the build left. */
export const GOLDEN_EXTRA_FILES: Readonly<Record<string, string>> = {
  "Innovator/Client/scripts/main.js": "main",
  "Innovator/Server/bin/Aras.Server.Core.dll": "dll",
  "Innovator/Server/temp/build.log": "log",
  "Innovator/Client/jsBundles/data.json": "{}",
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Method = Exclude<keyof SlotSystem, "secrets">;

export class FakeSlotSystem implements SlotSystem {
  readonly secrets = new MemorySecretStore();
  /** Every call, as `<method>` or `<method> <slot id>`, in order. */
  readonly calls: string[] = [];
  /** The host objects of slots, by name: folders, IIS applications, the database and the logins. */
  readonly objects = new Set<string>();
  /** The login passwords the database step was given, by login name. */
  readonly loginSecrets = new Map<string, Secret>();
  /** Whether the slots have an agent service (no golden has one yet: ticket 33b). */
  agentInstalled = false;
  /** The slots whose pools run, and whose agent runs, by slot id. */
  readonly running = new Set<string>();
  readonly agentRunning = new Set<string>();
  /** The URLs `warm` was asked for, in order, and what it answers. */
  readonly warmed: string[] = [];
  warmAnswer: (url: string) => WarmAnswer = () => ({ status: 200, ms: 50 });
  /** Slots whose pools, agent or processes run, by slot id: `createIis` starts one, `quiesce` and `stop` stop it. */
  readonly serving = new Set<string>();
  /** Tree-relative paths (lower-case, `\`-separated) the next `resetTree` mirror leaves as they are, as a failed copy would. */
  mirrorSkips: string[] = [];
  /** What `golden` answers. */
  goldenState: GoldenCheck = { state: "ok", hash: FAKE_GOLDEN_HASH };
  denyList: Record<string, string> = { "IIS pool DefaultAppPool": "p1", "install root C:\\Program Files (x86)\\Aras12\\Innovator": "c1" };
  private readonly files = new Map<string, Uint8Array>();
  private readonly faults = new Map<Method, unknown>();
  private clock = 0;

  constructor(readonly root: string = DEFAULT_INSTALL_ROOT) {
    for (const flavor of FLAVOR_KEYS) {
      const layout = goldenLayout(flavor, root);
      this.put(layout.edits, serializeEditList(editList(flavor)));
      this.put(layout.flavor, JSON.stringify({ schema: 1, flavor, ootbOwner: OOTB_OWNER }));
      for (const [file, text] of Object.entries({ ...sampleGolden(flavor), ...GOLDEN_EXTRA_FILES })) this.put(win32.join(layout.tree, ...file.split("/")), text);
      this.put(layout.manifest, serializeManifest(this.manifest(flavor)));
    }
  }

  /** The manifest of the flavor's golden tree as it stands: every file outside the runtime directories. */
  manifest(flavor: FlavorKey): Manifest {
    const tree = goldenLayout(flavor, this.root).tree;
    const entries = this.filesUnder(tree)
      .map((rel) => ({ rel, path: rel.replace(/\\/g, "/") }))
      .filter(({ path }) => !isRuntimePath(path, FLAVORS[flavor].runtimeDirs))
      .map(({ rel, path }) => {
        const bytes = this.files.get(`${tree.toLowerCase()}\\${rel}`)!;
        return { path, size: bytes.length, mtime: MTIME, sha256: sha256(bytes) };
      });
    return makeManifest(flavor, FLAVORS[flavor].serverBuild, entries);
  }

  /** Makes the next call to `method` throw `err`. */
  failNext(method: Method, err: unknown = new Error(`${method} failed`)): void {
    this.faults.set(method, err);
  }

  put(path: string, data: Uint8Array | string): void {
    this.files.set(path.toLowerCase(), typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  text(path: string): string | undefined {
    const bytes = this.files.get(path.toLowerCase());
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  /** The files under `dir`, relative and lower-case. */
  filesUnder(dir: string): string[] {
    const prefix = `${dir.toLowerCase()}\\`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).sort();
  }

  /** Everything of the slot the fake holds: its objects, files and stored secrets. */
  async leftovers(slot: SlotRef): Promise<string[]> {
    const n = slotNames(slot, this.root);
    const mine = [n.slotDir, n.vaultDir, `IIS application /${n.alias}`, `database ${n.database}`, `login ${n.logins.dbo}`, `login ${n.logins.reg}`];
    const left = mine.filter((o) => this.objects.has(o));
    left.push(...this.filesUnder(n.slotDir).map((f) => `file ${f}`));
    for (const role of ["dbo", "reg"] as const) if (await this.secrets.has(slotLoginSecretName(slot, role))) left.push(`secret ${role}`);
    return left;
  }

  private record(method: Method, slot?: SlotRef): void {
    this.calls.push(slot ? `${method} ${slot.flavor}-${String(slot.slot).padStart(2, "0")}` : method);
    if (this.faults.has(method)) {
      const err = this.faults.get(method);
      this.faults.delete(method);
      throw err;
    }
  }

  now(): number {
    return (this.clock += 100);
  }

  async golden(flavor: FlavorKey): Promise<GoldenCheck> {
    this.record("golden");
    void flavor;
    return this.goldenState;
  }

  async snapshotDenyList(): Promise<DenyListSnapshot> {
    this.record("snapshotDenyList");
    return { ...this.denyList };
  }

  async present(slot: SlotRef): Promise<readonly string[]> {
    this.record("present", slot);
    const n = slotNames(slot, this.root);
    return [n.slotDir, n.vaultDir, `IIS application /${n.alias}`, `database ${n.database}`].filter((o) => this.objects.has(o));
  }

  async makeFolders(slot: SlotRef): Promise<void> {
    this.record("makeFolders", slot);
    const n = slotNames(slot, this.root);
    this.objects.add(n.slotDir);
    this.objects.add(n.vaultDir);
  }

  async mirrorTree(slot: SlotRef): Promise<void> {
    this.record("mirrorTree", slot);
    const n = slotNames(slot, this.root);
    if (!this.objects.has(n.slotDir)) throw new Error(`${n.slotDir} does not exist`);
    const tree = goldenLayout(slot.flavor, this.root).tree;
    for (const rel of this.filesUnder(tree)) this.files.set(`${n.slotDir.toLowerCase()}\\${rel}`, this.files.get(`${tree.toLowerCase()}\\${rel}`)!);
  }

  async createIis(slot: SlotRef): Promise<number> {
    this.record("createIis", slot);
    this.serving.add(slotId(slot));
    this.objects.add(`IIS application /${slotNames(slot, this.root).alias}`);
    return 7;
  }

  async createAgent(slot: SlotRef): Promise<{ readonly installed: boolean; readonly port?: number }> {
    this.record("createAgent", slot);
    return { installed: false };
  }

  async restoreDatabase(slot: SlotRef, logins: SlotLogins): Promise<void> {
    this.record("restoreDatabase", slot);
    this.objects.add(`database ${databaseName(slot)}`);
    for (const role of ["dbo", "reg"] as const) {
      const login = loginName(slot, role);
      this.objects.add(`login ${login}`);
      this.loginSecrets.set(login, logins[role]);
    }
  }

  async start(slot: SlotRef, options: { readonly agent: boolean }): Promise<StartInfo> {
    this.record("start", slot);
    const id = slotId(slot);
    this.running.add(id);
    this.serving.add(id);
    if (options.agent && this.agentInstalled) this.agentRunning.add(id);
    return { pools: 7, agent: !options.agent ? "not asked" : this.agentInstalled ? "running" : "none", port: agentPort(slot) };
  }

  async stop(slot: SlotRef): Promise<StopInfo> {
    this.record("stop", slot);
    const id = slotId(slot);
    this.running.delete(id);
    this.serving.delete(id);
    const hadAgent = this.agentRunning.delete(id);
    return { pools: 7, agent: this.agentInstalled || hadAgent ? "stopped" : "none" };
  }

  async warm(url: string, timeoutMs: number): Promise<WarmAnswer> {
    this.record("warm");
    void timeoutMs;
    this.warmed.push(url);
    return this.warmAnswer(url);
  }

  async quiesce(slot: SlotRef): Promise<boolean> {
    this.record("quiesce", slot);
    if (!this.objects.has(slotNames(slot, this.root).slotDir)) return false;
    for (const set of [this.serving, this.running, this.agentRunning]) set.delete(slotId(slot));
    return true;
  }

  async resetTree(slot: SlotRef): Promise<TreeReset> {
    this.record("resetTree", slot);
    const n = slotNames(slot, this.root);
    if (!this.objects.has(n.slotDir)) return { state: "not-provisioned" };
    if (this.serving.has(slotId(slot))) return { state: "serving", serving: [`IIS pool ${n.alias}-root (Started)`] };
    const skips = new Set(this.mirrorSkips);
    this.mirrorSkips = [];
    const slotKey = n.slotDir.toLowerCase();
    const tree = goldenLayout(slot.flavor, this.root).tree.toLowerCase();
    // robocopy /MIR: what golden lacks goes (the stamp too), what it has is copied.
    for (const rel of this.filesUnder(n.slotDir)) if (!skips.has(rel) && !this.files.has(`${tree}\\${rel}`)) this.files.delete(`${slotKey}\\${rel}`);
    for (const rel of this.filesUnder(tree)) if (!skips.has(rel)) this.files.set(`${slotKey}\\${rel}`, this.files.get(`${tree}\\${rel}`)!);
    let runtimeEntries = 0;
    for (const rule of FLAVORS[slot.flavor].runtimeDirs.filter((r) => r.files === undefined)) {
      const dir = win32.join(n.slotDir, ...rule.dir.split("/"));
      for (const rel of this.filesUnder(dir)) {
        this.files.delete(`${dir.toLowerCase()}\\${rel}`);
        runtimeEntries++;
      }
    }
    const vault = this.filesUnder(n.vaultDir);
    for (const rel of vault) this.files.delete(`${n.vaultDir.toLowerCase()}\\${rel}`);
    const aspnet = this.objects.delete(`ASP.NET temporary files ${n.alias}`) ? 1 : 0;
    return { state: "reset", mirrorMs: 300, clearMs: 100, runtimeEntries, vaultEntries: vault.length, aspnetFolders: aspnet };
  }

  async verifyTree(slot: SlotRef, manifest: Manifest, rendered: readonly string[]): Promise<ManifestDiff> {
    this.record("verifyTree", slot);
    const dir = slotNames(slot, this.root).slotDir;
    const runtimeDirs = FLAVORS[slot.flavor].runtimeDirs;
    const observed: ObservedFile[] = this.filesUnder(dir)
      .map((rel) => ({ path: rel.replace(/\\/g, "/"), kind: "file" as const, size: this.files.get(`${dir.toLowerCase()}\\${rel}`)!.length, mtime: MTIME }))
      .filter((o) => !isRuntimePath(o.path, runtimeDirs));
    const hashes = new Map(
      pathsToHash(manifest, observed, "fast", runtimeDirs, rendered).map((p) => [p, sha256(this.files.get(`${dir.toLowerCase()}\\${p.replace(/\//g, "\\")}`)!)] as const),
    );
    return compareTree(manifest, observed, hashes, { level: "fast", runtimeDirs, rendered });
  }

  async removeAgent(slot: SlotRef): Promise<boolean> {
    this.record("removeAgent", slot);
    return false;
  }

  async removeDatabase(slot: SlotRef): Promise<Readonly<Record<string, number>>> {
    this.record("removeDatabase", slot);
    const out: Record<string, number> = {};
    for (const name of [`database ${databaseName(slot)}`, `login ${loginName(slot, "dbo")}`, `login ${loginName(slot, "reg")}`]) {
      out[name.split(" ")[1]!] = this.objects.delete(name) ? 1 : 0;
    }
    return out;
  }

  async removeIis(slot: SlotRef): Promise<void> {
    this.record("removeIis", slot);
    this.objects.delete(`IIS application /${slotNames(slot, this.root).alias}`);
  }

  async isDirectory(path: string): Promise<boolean> {
    this.record("isDirectory");
    return this.objects.has(path);
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    this.record("readFile");
    return this.files.get(path.toLowerCase()) ?? null;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.record("writeFile");
    this.put(path, data);
  }

  async removeDir(path: string): Promise<void> {
    this.record("removeDir");
    this.objects.delete(path);
    for (const rel of this.filesUnder(path)) this.files.delete(`${path.toLowerCase()}\\${rel}`);
  }

  async removeEmptyDir(path: string): Promise<void> {
    this.record("removeEmptyDir");
    void path;
  }
}
