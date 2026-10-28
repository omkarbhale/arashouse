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
import {
  DATABASE_MARKER,
  DEFAULT_INSTALL_ROOT,
  agentPort,
  databaseName,
  extractBackupScratch,
  goldenLayout,
  loginName,
  slotId,
  slotLoginSecretName,
  slotNames,
  slotOAuthSecretName,
  slotRootSecretName,
  type SlotRef,
} from "../core/names.js";
import type { Secret } from "../core/secret.js";
import { MemorySecretStore } from "../core/secret-store.js";
import type { ArasHttp } from "./aras-http.js";
import { HostError } from "../host/errors.js";
import type { DatabaseReading, EntryKind, GoldenCheck, SlotLogins, SlotSystem, StagedListing, StartInfo, StopInfo, TreeReset, WarmAnswer } from "./provision.js";
import type { DatabaseBackup } from "./backup-database.js";
import type { DatabaseMarker, DatabaseReset } from "./reset-database.js";
import type { SigningCertificate } from "./signing-cert.js";

export const FAKE_GOLDEN_HASH = "9".repeat(64);

/** Every file of the fake has this last-write time. */
const MTIME = "2026-10-28T10:00:00.0000000Z";

/** The golden's OAuth signing certificate and the copies of its public part (ticket 54): measured on 12sp9, 23 and 35. */
export const GOLDEN_SIGNING_FILES: Readonly<Record<string, string>> = {
  "OAuthServer/App_Data/Certificates/OAuthServer.pfx": "golden pfx",
  "OAuthServer/App_Data/Certificates/OAuthServer.cer": "golden cer",
  "Innovator/Server/App_Data/Certificates/OAuthServer.cer": "golden cer",
  "VaultServer/App_Data/Certificates/OAuthServer.cer": "golden cer",
};

/** Golden files beyond the configs: a client script, the server's main DLL, runtime files the build left, and the signing certificate. */
export const GOLDEN_EXTRA_FILES: Readonly<Record<string, string>> = {
  "Innovator/Client/scripts/main.js": "main",
  "Innovator/Server/bin/Aras.Server.Core.dll": "dll",
  "Innovator/Server/temp/build.log": "log",
  "Innovator/Client/jsBundles/data.json": "{}",
  ...GOLDEN_SIGNING_FILES,
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Method = Exclude<keyof SlotSystem, "secrets" | "aras">;

export class FakeSlotSystem implements SlotSystem {
  readonly secrets = new MemorySecretStore();
  /** The slots' Aras servers: every login and edit answers ok unless a test puts its own fake here. */
  aras: ArasHttp = {
    login: async () => ({ ok: true, detail: "token issued" }),
    setPasswords: async (_alias, _database, _as, logins) => ({ ok: true, detail: `edited ${logins.join(" and ")}` }),
  };
  /** Every call, as `<method>` or `<method> <slot id>`, in order. */
  readonly calls: string[] = [];
  /** The host objects of slots, by name: folders, IIS applications, the database and the logins. */
  readonly objects = new Set<string>();
  /** The login passwords the database step was given, by login name. */
  readonly loginSecrets = new Map<string, Secret>();
  /** The signing certificates made, in order: the slot, and the password each pfx was encrypted with. */
  readonly signingCertificates: { readonly slot: string; readonly password: Secret }[] = [];
  /** Whether the golden has an agent service (ticket 33b), so a provision makes the slot's and a start can start it. */
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
  /** The marker the last reset wrote, by database name. */
  readonly databaseMarkers = new Map<string, DatabaseMarker>();
  /** The version rows a restored database holds. */
  databaseVersion: Record<string, string> = { VersionMajor: "12", VersionMinor: "0", VersionServicePack: "SP9", VersionBuild: "24090" };
  /** The page `warm` answers for a URL with `readBody` (DBList.aspx lists the slot's database by default). */
  pageBody: (url: string) => string = (url) => {
    const alias = /\/(ah-[a-z0-9]+-\d{2})\//.exec(url)?.[1] ?? "";
    return `<DBList><DB id="${alias.replace(/^ah-/, "arashouse_").replace(/-/g, "_")}"/></DBList>`;
  };
  /** Overrides parts of what `resetDatabase` answers. */
  resetAnswer: Partial<Extract<DatabaseReset, { state: "restored" }>> = {};
  /** What `golden` answers. */
  goldenState: GoldenCheck = { state: "ok", hash: FAKE_GOLDEN_HASH };
  denyList: Record<string, string> = { "IIS pool DefaultAppPool": "p1", "install root C:\\Program Files (x86)\\Aras12\\Innovator": "c1" };
  /** Paths (lower-case) that are links or junctions, as a leaseholder or a worker could make them. */
  readonly links = new Set<string>();
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
    if (await this.secrets.has(slotRootSecretName(slot))) left.push("secret root");
    if (await this.secrets.has(slotOAuthSecretName(slot))) left.push("secret oauth");
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
    return this.agentInstalled ? { installed: true, port: agentPort(slot) } : { installed: false };
  }

  async restoreDatabase(slot: SlotRef, logins: SlotLogins, marker: DatabaseMarker): Promise<void> {
    this.record("restoreDatabase", slot);
    this.objects.add(`database ${databaseName(slot)}`);
    this.databaseMarkers.set(databaseName(slot), marker);
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

  async resetDatabase(slot: SlotRef, marker: DatabaseMarker): Promise<DatabaseReset> {
    this.record("resetDatabase", slot);
    if (!this.objects.has(`database ${databaseName(slot)}`)) return { state: "missing" };
    this.databaseMarkers.set(databaseName(slot), marker);
    const written = { [DATABASE_MARKER.goldenHash]: marker.goldenHash, [DATABASE_MARKER.resetAt]: marker.resetAt };
    return { state: "restored", restoreMs: 1400, killed: 0, access: "MULTI_USER", marker: written, version: { ...this.databaseVersion }, ...this.resetAnswer };
  }

  async backupDatabase(slot: SlotRef): Promise<DatabaseBackup> {
    this.record("backupDatabase", slot);
    if (!this.objects.has(`database ${databaseName(slot)}`)) return { state: "missing" };
    const bytes = new TextEncoder().encode(`COPY_ONLY backup of ${databaseName(slot)}`);
    this.put(extractBackupScratch(slot, this.root), bytes);
    return { state: "backed-up", backupMs: 900, bytes: bytes.length };
  }

  async stop(slot: SlotRef): Promise<StopInfo> {
    this.record("stop", slot);
    const id = slotId(slot);
    this.running.delete(id);
    this.serving.delete(id);
    const hadAgent = this.agentRunning.delete(id);
    return { pools: 7, agent: this.agentInstalled || hadAgent ? "stopped" : "none" };
  }

  async warm(url: string, timeoutMs: number, readBody?: boolean): Promise<WarmAnswer> {
    this.record("warm");
    void timeoutMs;
    this.warmed.push(url);
    const answer = this.warmAnswer(url);
    return readBody === true && answer.status !== undefined ? { body: this.pageBody(url), ...answer } : answer;
  }

  async readDatabase(slot: SlotRef): Promise<DatabaseReading> {
    this.record("readDatabase", slot);
    if (!this.objects.has(`database ${databaseName(slot)}`)) return { state: "missing" };
    const marker = this.databaseMarkers.get(databaseName(slot));
    const read: Record<string, string> = marker ? { [DATABASE_MARKER.goldenHash]: marker.goldenHash, [DATABASE_MARKER.resetAt]: marker.resetAt } : {};
    return { state: "read", marker: read, version: { ...this.databaseVersion } };
  }


  async quiesce(slot: SlotRef): Promise<boolean> {
    this.record("quiesce", slot);
    if (!this.objects.has(slotNames(slot, this.root).slotDir)) return false;
    for (const set of [this.serving, this.running, this.agentRunning]) set.delete(slotId(slot));
    return true;
  }

  /** A made-up certificate, new each time: a DER-like .cer (a SEQUENCE tag) and a pfx naming it, neither holding the password. */
  async newSigningCertificate(slot: SlotRef, password: Secret): Promise<SigningCertificate> {
    this.record("newSigningCertificate", slot);
    this.signingCertificates.push({ slot: slotId(slot), password });
    const n = this.signingCertificates.length;
    const cer = new Uint8Array(128).fill(n % 256);
    cer[0] = 0x30;
    return { pfx: new TextEncoder().encode(`fake pfx ${n} of ${slotId(slot)}`), cer };
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

  async copyFile(from: string, to: string): Promise<boolean> {
    this.record("copyFile");
    const bytes = this.files.get(from.toLowerCase());
    if (bytes === undefined) throw new Error(`${from} does not exist`);
    if (this.files.has(to.toLowerCase())) return false;
    this.put(to, bytes);
    return true;
  }

  async removeFile(path: string): Promise<void> {
    this.record("removeFile");
    this.files.delete(path.toLowerCase());
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

  private kind(path: string): EntryKind {
    const key = path.toLowerCase();
    if (this.links.has(key)) return "link";
    if (this.files.has(key)) return "file";
    if (this.objects.has(path) || this.filesUnder(path).length > 0) return "dir";
    return "missing";
  }

  async entryKind(path: string): Promise<EntryKind> {
    this.record("entryKind");
    return this.kind(path);
  }

  async listStaged(dir: string): Promise<StagedListing> {
    this.record("listStaged");
    if (this.kind(dir) !== "dir") throw new HostError("Refused", `the staged folder ${dir} is missing or not a plain folder`);
    const prefix = `${dir.toLowerCase()}\\`;
    const refused = [...this.links].filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).replace(/\\/g, "/"));
    const files = this.filesUnder(dir)
      .filter((rel) => !refused.some((r) => rel.replace(/\\/g, "/").startsWith(`${r}/`)))
      .map((rel) => ({ path: rel.replace(/\\/g, "/"), size: this.files.get(`${prefix}${rel}`)!.length }));
    return { files, refused };
  }

  async readStaged(path: string, maxBytes: number): Promise<Uint8Array> {
    this.record("readStaged");
    const bytes = this.files.get(path.toLowerCase());
    if (bytes === undefined || this.links.has(path.toLowerCase())) throw new HostError("Refused", `the staged ${path} is not a plain file`);
    if (bytes.length > maxBytes) throw new HostError("Refused", `the staged file ${path} is larger than ${maxBytes} bytes`);
    return bytes;
  }

  async copyStaged(from: string, to: string): Promise<{ readonly bytes: number }> {
    this.record("copyStaged");
    const bytes = this.files.get(from.toLowerCase());
    if (bytes === undefined || this.links.has(from.toLowerCase())) throw new HostError("Refused", `the staged ${from} is not a plain file`);
    this.put(to, bytes);
    return { bytes: bytes.length };
  }

  async removeTreeFile(path: string): Promise<boolean> {
    this.record("removeTreeFile");
    const kind = this.kind(path);
    if (kind === "missing") return false;
    if (kind !== "file") throw new HostError("Refused", `${path} is a ${kind}, not a file`);
    return this.files.delete(path.toLowerCase());
  }

  async removeStaged(path: string): Promise<void> {
    this.record("removeStaged");
    const key = path.toLowerCase();
    for (const l of [...this.links]) if (l === key || l.startsWith(`${key}\\`)) this.links.delete(l);
    this.objects.delete(path);
    for (const rel of this.filesUnder(path)) this.files.delete(`${key}\\${rel}`);
  }

  async clearCompiled(slot: SlotRef): Promise<number> {
    this.record("clearCompiled", slot);
    return this.objects.delete(`ASP.NET temporary files ${slotNames(slot, this.root).alias}`) ? 1 : 0;
  }
}
