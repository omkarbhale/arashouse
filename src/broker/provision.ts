// The broker's `provisionSlot` and `destroySlot` verbs (ticket 25, docs/provision.md): a slot made
// from its flavor's golden, never by an installer. Every effect goes through a `SlotSystem`
// (slot-system.ts on the host, a fake in the tests), so the order, the idempotency and the rollback
// are tested offline.
//
// A provision runs its steps in order, each safe to run again: a provision that stopped half way is
// finished by the next one. The slot stamp is the last thing it writes, so a slot with a stamp is
// provisioned and is refused. A step that fails removes everything of the slot again (the destroy
// steps) before the error is answered. Both verbs fingerprint the deny-list before and after.

import { win32 } from "node:path";
import { OOTB_OWNER, compareDenyList, goldenJson, type DenyListDiff, type DenyListSnapshot } from "../core/baseline.js";
import { editListFiles, editVars, parseEditList, renderFile, secretsNeeded, type EditSecrets } from "../core/edits.js";
import { FLAVORS, type FlavorKey } from "../core/flavors.js";
import { licenceSecretName } from "../core/licence.js";
import { goldenLayout, slotId, slotLoginSecretName, stampFile, type LoginRole, type SlotNames, type SlotRef } from "../core/names.js";
import { redact } from "../core/redact.js";
import { Secret } from "../core/secret.js";
import type { SecretStore } from "../core/secret-store.js";
import type { SlotStamp } from "../host/driver.js";
import { HostError, isHostError } from "../host/errors.js";
import { newLoginPassword } from "./baseline-build.js";
import type { Broker, VerbContext } from "./broker.js";
import type { WireResult } from "./protocol.js";

/** The provision's steps, in order; `destroySlot` undoes them in reverse. */
export const PROVISION_STEPS = ["golden", "snapshot", "folders", "tree", "iis", "agent", "database", "configs", "stamp", "deny-list"] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

/** The destroy's steps, in order: the provision's in reverse, the pools and agent stopped first. */
export const DESTROY_STEPS = ["stop", "agent", "database", "iis", "folders", "secrets"] as const;
export type DestroyStep = (typeof DESTROY_STEPS)[number];

/** The flavor's golden as a provision needs it. */
export type GoldenCheck =
  | { readonly state: "ok"; readonly hash: string }
  /** A `baseline build --replace` is moving a new golden into place. */
  | { readonly state: "promoting" }
  | { readonly state: "unusable"; readonly detail: string };

/** The slot's two SQL login passwords. */
export interface SlotLogins {
  readonly dbo: Secret;
  readonly reg: Secret;
}

/** Every effect the two verbs have on the host. The slot's names and paths are derived on both sides of this seam. */
export interface SlotSystem {
  now(): number;
  /** Checks `golden\<key>` against its manifest (`golden` level) and returns the manifest hash. */
  golden(flavor: FlavorKey): Promise<GoldenCheck>;
  snapshotDenyList(): Promise<DenyListSnapshot>;
  /** What of the slot exists, by name (its SQL logins excepted: the broker cannot see them). */
  present(slot: SlotRef): Promise<readonly string[]>;
  /** The slot and vault folders, with the IIS accounts' grants. */
  makeFolders(slot: SlotRef): Promise<void>;
  /** `robocopy /MIR` of the golden tree over the slot folder (the stamp left alone). */
  mirrorTree(slot: SlotRef): Promise<void>;
  /** The applications and pools of the golden's `iis.json`; returns how many applications. */
  createIis(slot: SlotRef): Promise<number>;
  /** The agent service of the golden's `service.json`, if it has one. */
  createAgent(slot: SlotRef): Promise<{ readonly installed: boolean; readonly port?: number }>;
  /** The database from the golden's `ootb.bak`, its two logins and their users. */
  restoreDatabase(slot: SlotRef, logins: SlotLogins): Promise<void>;
  /** Stops the slot's pools and agent and waits for its worker processes to end. */
  stop(slot: SlotRef): Promise<void>;
  /** True when there was a service to remove. */
  removeAgent(slot: SlotRef): Promise<boolean>;
  /** Drops the database and the two logins; answers 1 (dropped) or 0 (absent) for each name. */
  removeDatabase(slot: SlotRef): Promise<Readonly<Record<string, number>>>;
  removeIis(slot: SlotRef): Promise<void>;
  /** A file's bytes, or null when it does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Removes a folder and everything in it; nothing when it does not exist. */
  removeDir(path: string): Promise<void>;
  /** Removes a folder only when it is empty. */
  removeEmptyDir(path: string): Promise<void>;
  /** Machine-scope DPAPI under `<root>\secrets\` on the host. */
  readonly secrets: SecretStore;
}

const LOGIN_ROLES: readonly LoginRole[] = ["dbo", "reg"];

function seconds(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

function errorText(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

function denyListText(diff: DenyListDiff): string {
  const parts = [
    diff.changed.length > 0 ? `changed ${diff.changed.join(", ")}` : "",
    diff.missing.length > 0 ? `gone ${diff.missing.join(", ")}` : "",
    diff.added.length > 0 ? `new ${diff.added.join(", ")}` : "",
  ].filter(Boolean);
  return `the deny-list objects differ (${parts.join("; ")})`;
}

/** The step timings of one verb, for its detail line. */
class Timings {
  private readonly parts: string[] = [];
  constructor(private readonly system: SlotSystem) {}

  async run<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const started = this.system.now();
    try {
      return await fn();
    } finally {
      this.parts.push(`${step} ${seconds(this.system.now() - started)}`);
    }
  }

  toString(): string {
    return this.parts.join(", ");
  }
}

/** The slot's stored login passwords, made and stored on the first provision and reused by the next. */
async function loginPasswords(store: SecretStore, slot: SlotRef): Promise<SlotLogins> {
  const out: Partial<Record<LoginRole, Secret>> = {};
  for (const role of LOGIN_ROLES) {
    const name = slotLoginSecretName(slot, role);
    let secret = await store.get(name);
    if (secret === undefined || secret.kind !== "sql-login" || secret.length < 16) {
      secret = newLoginPassword();
      await store.put(name, secret);
    }
    out[role] = secret;
  }
  return out as SlotLogins;
}

/**
 * Renders the golden's edit list into the slot's config files, from the golden's bytes. The licence comes from the
 * host's store (`licence-<line>`); without one the key stays blank, as in golden, and the detail says so.
 */
async function renderConfigs(system: SlotSystem, slot: SlotRef, root: string, logins: SlotLogins): Promise<string> {
  const layout = goldenLayout(slot.flavor, root);
  const listBytes = await system.readFile(layout.edits);
  if (listBytes === null) throw new Error(`${layout.edits} does not exist`);
  const list = parseEditList(JSON.parse(new TextDecoder().decode(listBytes)));
  if (list.flavor !== slot.flavor) throw new Error(`${layout.edits} is the edit list of flavor ${list.flavor}`);
  const needed = secretsNeeded(list);
  const licence = needed.some((h) => h === "licence" || h === "licence_act_key")
    ? await system.secrets.get(licenceSecretName(FLAVORS[slot.flavor].licence.line))
    : undefined;
  const blank = Secret.of("", "licence");
  const available: EditSecrets = {
    db_dbo_password: logins.dbo,
    db_reg_password: logins.reg,
    licence: licence ?? blank,
    // The `act_key` that goes with a stored key is not kept yet: a slot that must log in needs it (docs/baselines.md).
    licence_act_key: blank,
  };
  const secrets: EditSecrets = Object.fromEntries(needed.map((h) => [h, available[h]]));
  const slotDir = win32.dirname(stampFile(slot, root));
  let applied = 0;
  const files = editListFiles(list);
  for (const file of files) {
    const parts = file.split("/");
    const golden = await system.readFile(win32.join(layout.tree, ...parts));
    if (golden === null) throw new Error(`the golden tree has no ${file}`);
    const rendered = renderFile(file, golden, list, editVars(slot, root), secrets);
    applied += rendered.outcomes.filter((o) => o.status === "applied").length;
    await system.writeFile(win32.join(slotDir, ...parts), rendered.bytes);
  }
  const note = needed.includes("licence") && licence === undefined ? `; no licence key is stored for line ${FLAVORS[slot.flavor].licence.line}, so the slot cannot log in yet` : "";
  return `${files.length} files, ${applied} edits${note}`;
}

/**
 * Why the golden's `ootb.bak` cannot be restored into a slot, or undefined. The broker restores it as the owner of the
 * slot database, and can then use, map and drop the database only when the dbo inside the backup is the broker too:
 * `flavor.json`'s `ootbOwner` says the build handed its database to the broker before the backup.
 */
async function ootbUnusable(system: SlotSystem, flavor: FlavorKey, root: string): Promise<string | undefined> {
  const file = goldenLayout(flavor, root).flavor;
  const bytes = await system.readFile(file);
  if (bytes === null) return `${file} does not exist`;
  let record: { ootbOwner?: unknown };
  try {
    record = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")) as { ootbOwner?: unknown };
  } catch {
    return `${file} is not JSON`;
  }
  if (record.ootbOwner !== OOTB_OWNER) {
    return `its db\\ootb.bak was taken before the build gave its database to ${OOTB_OWNER}, so the broker could not use or drop a slot database restored from it; rebuild it with \`arashouse baseline build ${flavor} --replace\``;
  }
  return undefined;
}

/** The stamp of a slot just made from golden: its golden hash, the time, no lease. */
export function provisionStamp(slot: SlotRef, goldenHash: string, now: number): SlotStamp {
  return { slotId: slotId(slot), flavor: slot.flavor, goldenHash, lastResetAt: new Date(now).toISOString(), leaseId: null };
}

/** The destroy steps, without the deny-list check: what both a destroy and a failed provision's rollback run. Returns what is left. */
async function removeSlot(system: SlotSystem, slot: SlotRef, names: SlotNames, timings: Timings): Promise<readonly string[]> {
  const errors: string[] = [];
  const attempt = async (step: DestroyStep, fn: () => Promise<unknown>) => {
    try {
      await timings.run(step, fn);
    } catch (err) {
      errors.push(`${step}: ${errorText(err)}`);
    }
  };
  // Each step runs even when one before it failed, so a rollback removes all it can.
  await attempt("stop", () => system.stop(slot));
  await attempt("agent", () => system.removeAgent(slot));
  await attempt("database", () => system.removeDatabase(slot));
  await attempt("iis", () => system.removeIis(slot));
  await attempt("folders", async () => {
    await system.removeDir(names.slotDir);
    await system.removeDir(names.vaultDir);
    await system.removeEmptyDir(win32.dirname(names.slotDir));
  });
  await attempt("secrets", async () => {
    for (const role of LOGIN_ROLES) await system.secrets.delete(slotLoginSecretName(slot, role));
  });
  let left: readonly string[];
  try {
    left = await system.present(slot);
  } catch (err) {
    left = [`(could not list what is left: ${errorText(err)})`];
  }
  return [...errors.map((e) => `(${e})`), ...left];
}

/** `provisionSlot`: makes the slot from golden. Throws a `HostError`; a failure after the first change is rolled back. */
export async function provisionSlotOnHost(system: SlotSystem, slot: SlotRef, names: SlotNames, root: string): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  const timings = new Timings(system);
  if ((await system.readFile(stampFile(slot, root))) !== null) throw new HostError("Refused", `slot ${id} is already provisioned`);

  const golden = await timings.run("golden", () => system.golden(slot.flavor));
  if (golden.state === "promoting") throw new HostError("Retryable", `a new ${slot.flavor} golden is being moved into place; provision ${id} when it is done`);
  if (golden.state === "unusable") throw new HostError("Refused", `the ${slot.flavor} golden cannot be provisioned from: ${golden.detail}`);
  const unusable = await ootbUnusable(system, slot.flavor, root);
  if (unusable) throw new HostError("Refused", `the ${slot.flavor} golden cannot be provisioned from: ${unusable}`);
  const before = await timings.run("snapshot", () => system.snapshotDenyList());

  let step: ProvisionStep = "folders";
  let notes: string[] = [];
  try {
    await timings.run(step, () => system.makeFolders(slot));
    step = "tree";
    await timings.run(step, () => system.mirrorTree(slot));
    step = "iis";
    const apps = await timings.run(step, () => system.createIis(slot));
    step = "agent";
    const agent = await timings.run(step, () => system.createAgent(slot));
    step = "database";
    const logins = await timings.run(step, async () => {
      const l = await loginPasswords(system.secrets, slot);
      await system.restoreDatabase(slot, l);
      return l;
    });
    step = "configs";
    const configs = await timings.run(step, () => renderConfigs(system, slot, root, logins));
    step = "stamp";
    await timings.run(step, () => system.writeFile(stampFile(slot, root), goldenJson(provisionStamp(slot, golden.hash, system.now()))));
    step = "deny-list";
    const deny = compareDenyList(before, await timings.run(step, () => system.snapshotDenyList()));
    if (!deny.ok) throw new HostError("Quarantine", denyListText(deny));
    notes = [`${apps} IIS applications`, agent.installed ? `agent on port ${agent.port}` : "no agent", `configs: ${configs}`];
  } catch (err) {
    const left = await removeSlot(system, slot, names, new Timings(system));
    let deny: DenyListDiff | undefined;
    try {
      deny = compareDenyList(before, await system.snapshotDenyList());
    } catch {
      deny = undefined;
    }
    const after = [
      left.length > 0 ? `the rollback left ${left.join(", ")}` : "rolled back",
      deny === undefined ? "the deny-list could not be checked again" : deny.ok ? "" : denyListText(deny),
    ].filter(Boolean);
    const kind = isHostError(err) ? err.kind : "Retryable";
    throw new HostError(kind, `provision of ${id} failed at ${step}: ${errorText(err)}; ${after.join("; ")}`, { cause: err });
  }
  return {
    ok: true,
    detail: `provisioned ${id} from golden ${golden.hash.slice(0, 12)} in ${seconds(system.now() - started)} s (${notes.join("; ")}; ${timings})`,
  };
}

/** `destroySlot`: removes everything a provision made, by the slot's derived names. Idempotent. */
export async function destroySlotOnHost(system: SlotSystem, slot: SlotRef, names: SlotNames): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  const timings = new Timings(system);
  const before = await timings.run("snapshot", () => system.snapshotDenyList());
  const left = await removeSlot(system, slot, names, timings);
  const deny = compareDenyList(before, await timings.run("deny-list", () => system.snapshotDenyList()));
  if (!deny.ok) throw new HostError("Quarantine", `destroy of ${id}: ${denyListText(deny)}`);
  if (left.length > 0) throw new HostError("Retryable", `destroy of ${id} left ${left.join(", ")}; destroying it again removes the rest`);
  return { ok: true, detail: `destroyed ${id} in ${seconds(system.now() - started)} s (${timings})` };
}

/** Registers `provisionSlot` and `destroySlot` on `broker`. One provision or destroy runs per slot at a time. */
export function registerSlotVerbs(broker: Broker, system: SlotSystem): Broker {
  const busy = new Set<string>();
  const exclusive = async (ctx: VerbContext, fn: (slot: SlotRef, names: SlotNames) => Promise<WireResult>): Promise<WireResult> => {
    const slot = ctx.slot as SlotRef;
    const id = slotId(slot);
    if (busy.has(id)) throw new HostError("Retryable", `slot ${id} is being provisioned or destroyed already`);
    busy.add(id);
    try {
      return await fn(slot, ctx.names as SlotNames);
    } finally {
      busy.delete(id);
    }
  };
  return broker
    .register("provisionSlot", {
      target: "slot",
      run: (ctx) => exclusive(ctx, (slot, names) => provisionSlotOnHost(system, slot, names, ctx.root)),
    })
    .register("destroySlot", {
      target: "slot",
      run: (ctx) => exclusive(ctx, (slot, names) => destroySlotOnHost(system, slot, names)),
    });
}
