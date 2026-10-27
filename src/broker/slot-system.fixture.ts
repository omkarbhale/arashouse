// A `SlotSystem` in memory, for the provision and destroy tests: golden files from the sample
// configs (config-samples.fixture.ts), the slot's host objects by name, a call record and one-shot
// faults. Paths are the Windows paths the verbs derive, compared without case, as Windows does.

import { win32 } from "node:path";
import { OOTB_OWNER, type DenyListSnapshot } from "../core/baseline.js";
import { sampleGolden } from "../core/config-samples.fixture.js";
import { serializeEditList } from "../core/edits.js";
import { editList } from "../core/edit-lists.js";
import { FLAVOR_KEYS, type FlavorKey } from "../core/flavors.js";
import { DEFAULT_INSTALL_ROOT, agentPort, databaseName, goldenLayout, loginName, slotId, slotLoginSecretName, slotNames, type SlotRef } from "../core/names.js";
import type { Secret } from "../core/secret.js";
import { MemorySecretStore } from "../core/secret-store.js";
import type { GoldenCheck, SlotLogins, SlotSystem, StartInfo, StopInfo, WarmAnswer } from "./provision.js";

export const FAKE_GOLDEN_HASH = "9".repeat(64);

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
      for (const [file, text] of Object.entries(sampleGolden(flavor))) this.put(win32.join(layout.tree, ...file.split("/")), text);
      this.put(win32.join(layout.tree, "Innovator", "Server", "bin", "Aras.Server.Core.dll"), "dll");
    }
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
    if (options.agent && this.agentInstalled) this.agentRunning.add(id);
    return { pools: 7, agent: !options.agent ? "not asked" : this.agentInstalled ? "running" : "none", port: agentPort(slot) };
  }

  async stop(slot: SlotRef): Promise<StopInfo> {
    this.record("stop", slot);
    const id = slotId(slot);
    this.running.delete(id);
    const hadAgent = this.agentRunning.delete(id);
    return { pools: 7, agent: this.agentInstalled || hadAgent ? "stopped" : "none" };
  }

  async warm(url: string, timeoutMs: number): Promise<WarmAnswer> {
    this.record("warm");
    void timeoutMs;
    this.warmed.push(url);
    return this.warmAnswer(url);
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
