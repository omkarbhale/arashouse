// Derived names: pure functions of (flavor, slot number). Everything the tool names on the host
// comes from here; no other module builds a name or a path. Whether a name may be touched is
// guards.ts's question (`assertOwned`), not this file's.

import { win32 } from "node:path";
import { FLAVOR_KEYS, type FlavorKey, isFlavorKey } from "./flavors.js";

/** Default install root: outside Program Files, on the Windows side. Overridable only at setup (ticket 21). */
export const DEFAULT_INSTALL_ROOT = "C:\\aras_installations";

/** The one utility database the tool owns besides the per-slot ones. */
export const UTILITY_DATABASE = "arashouse_admin";

/** Slot numbers run 1 to 99 (`NN` is two digits). */
export const MAX_SLOT = 99;

/** First port of the reserved agent block; 8734-8736 are taken on the host. */
export const AGENT_PORT_BASE = 8800;

/** The Aras application pools a slot runs, named by role. */
export const APP_POOL_ROLES = ["server", "oauth", "vault", "conversion"] as const;
export type AppPoolRole = (typeof APP_POOL_ROLES)[number];

export type LoginRole = "dbo" | "reg";

/** A slot is one (flavor, number) pair. */
export interface SlotRef {
  readonly flavor: FlavorKey;
  readonly slot: number;
}

/** A lease id as it appears in a folder name: conservative, no separators, no dots. */
const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function flavorOf(flavor: string): FlavorKey {
  if (!isFlavorKey(flavor)) throw new Error(`unknown flavor "${flavor}"`);
  return flavor;
}

/** `NN`: the slot number zero-padded to two digits; throws outside 1 to 99. */
export function slotNumber(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) {
    throw new Error(`slot number must be an integer from 1 to ${MAX_SLOT}, got ${String(slot)}`);
  }
  return String(slot).padStart(2, "0");
}

function tag(ref: SlotRef): string {
  return `${flavorOf(ref.flavor)}_${slotNumber(ref.slot)}`;
}

function dashTag(ref: SlotRef): string {
  return `${flavorOf(ref.flavor)}-${slotNumber(ref.slot)}`;
}

/** `<key>-<NN>`: the slot's id, as the state file and the slot stamp name it (`23-02`). */
export function slotId(ref: SlotRef): string {
  return dashTag(ref);
}

/** The inverse of `slotId`; throws on anything that is not `<registered key>-<NN>`. */
export function parseSlotId(id: string): SlotRef {
  const m = /^([a-z0-9]+)-(\d{2})$/.exec(typeof id === "string" ? id : "");
  const flavor = m?.[1];
  if (!m || flavor === undefined || !isFlavorKey(flavor)) throw new Error(`"${String(id)}" is not a slot id (<flavor>-<NN>)`);
  const ref = { flavor, slot: Number(m[2]) };
  slotNumber(ref.slot);
  return ref;
}

/** `arashouse_<key>_<NN>` */
export function databaseName(ref: SlotRef): string {
  return `arashouse_${tag(ref)}`;
}

/** `ah-<key>-<NN>` */
export function webAlias(ref: SlotRef): string {
  return `ah-${dashTag(ref)}`;
}

/** `ah-<key>-<NN>-<role>` */
export function appPoolName(ref: SlotRef, role: AppPoolRole): string {
  if (!(APP_POOL_ROLES as readonly string[]).includes(role)) throw new Error(`unknown app pool role "${role}"`);
  return `${webAlias(ref)}-${role}`;
}

/** `ArasHouseAgent_<key>_<NN>` */
export function agentServiceName(ref: SlotRef): string {
  return `ArasHouseAgent_${tag(ref)}`;
}

/** The agent's port: 8800 plus 100 per flavor (registry order) plus the slot number. */
export function agentPort(ref: SlotRef): number {
  const index = FLAVOR_KEYS.indexOf(flavorOf(ref.flavor));
  slotNumber(ref.slot);
  return AGENT_PORT_BASE + index * 100 + ref.slot;
}

/** `arashouse_<key>_<NN>_dbo` or `_reg` */
export function loginName(ref: SlotRef, role: LoginRole): string {
  if (role !== "dbo" && role !== "reg") throw new Error(`unknown login role "${String(role)}"`);
  return `${databaseName(ref)}_${role}`;
}

/** `<root>\slots\<key>\<NN>` */
export function slotDir(ref: SlotRef, root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(root, "slots", flavorOf(ref.flavor), slotNumber(ref.slot));
}

/** The slot stamp's file name inside the slot folder (ticket 11). */
export const STAMP_FILE_NAME = ".arashouse-slot.json";

/** `<root>\slots\<key>\<NN>\.arashouse-slot.json` */
export function stampFile(ref: SlotRef, root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(slotDir(ref, root), STAMP_FILE_NAME);
}

/** `<root>\vaults\<key>-<NN>` */
export function vaultDir(ref: SlotRef, root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(root, "vaults", dashTag(ref));
}

/** `<root>\golden\<key>` */
export function goldenDir(flavor: FlavorKey, root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(root, "golden", flavorOf(flavor));
}

/** The MSI's default agent port (`AS_PORT`), which a baseline install keeps and its golden config names. */
export const MSI_DEFAULT_AGENT_PORT = 8734;

/**
 * The names a flavor's baseline is installed under (ticket 24): a throw-away instance whose tree is
 * then copied to golden, so the golden's config files still name it and the edit list replaces them.
 */
export interface BuildNames {
  /** `ah-build-<key>` */
  readonly alias: string;
  /** `arashouse_build_<key>`; the build's SQL logins are this plus `_dbo` and `_reg`. */
  readonly database: string;
  /** `<root>\golden-build\<key>`: the install directory. */
  readonly dir: string;
  readonly agentPort: number;
}

export function buildNames(flavor: FlavorKey, root: string = DEFAULT_INSTALL_ROOT): BuildNames {
  const key = flavorOf(flavor);
  return {
    alias: `ah-build-${key}`,
    database: `arashouse_build_${key}`,
    dir: win32.join(root, "golden-build", key),
    agentPort: MSI_DEFAULT_AGENT_PORT,
  };
}

/** `<root>\staging\<lease_id>` */
export function stagingDir(leaseId: string, root: string = DEFAULT_INSTALL_ROOT): string {
  if (!LEASE_ID.test(leaseId)) throw new Error("lease id must be 1 to 64 letters, digits, '_' or '-'");
  return win32.join(root, "staging", leaseId);
}

/** `<root>\sqldata` */
export function sqlDataDir(root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(root, "sqldata");
}

/** `<root>\logs`: the broker's audit log and the reset workers' logs. */
export function logsDir(root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(root, "logs");
}

/** `<root>\logs\broker-YYYYMMDD.log`: the broker's audit log for one UTC day. */
export function auditLogFile(day: Date, root: string = DEFAULT_INSTALL_ROOT): string {
  if (Number.isNaN(day.getTime())) throw new Error("the audit day must be a valid date");
  const ymd = day.toISOString().slice(0, 10).replace(/-/g, "");
  return win32.join(logsDir(root), `broker-${ymd}.log`);
}

/** `<root>\broker`: the broker's code (`app\`) and its client token; the worker user may read it, not write it (ticket 21). */
export function brokerDir(root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(root, "broker");
}

/** `<root>\broker\app\broker\client.js`: the Windows-side client WSL runs through interop (the installed `dist\`). */
export function brokerClientScript(root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(brokerDir(root), "app", "broker", "client.js");
}

/** `<root>\broker\client.token`: the token the broker writes at each start and its client presents. */
export function brokerTokenFile(root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(brokerDir(root), "client.token");
}

/** A stored secret's name: lower-case, digits and '-', so it is safe as a file name (`licence-14`). */
const SECRET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSecretName(name: unknown): name is string {
  return typeof name === "string" && SECRET_NAME.test(name);
}

/** `<root>\secrets`: machine-scope DPAPI blobs, ACL'd to SYSTEM and the broker account (ticket 21). */
export function secretsDir(root: string = DEFAULT_INSTALL_ROOT): string {
  return win32.join(root, "secrets");
}

/** `<root>\secrets\<name>.bin` */
export function secretFile(name: string, root: string = DEFAULT_INSTALL_ROOT): string {
  if (!isSecretName(name)) throw new Error("secret name must be 1 to 64 lower-case letters, digits or '-'");
  return win32.join(secretsDir(root), `${name}.bin`);
}

/** Every name a slot owns on the host. */
export interface SlotNames {
  readonly database: string;
  readonly alias: string;
  readonly appPools: Readonly<Record<AppPoolRole, string>>;
  readonly service: string;
  readonly agentPort: number;
  readonly logins: Readonly<Record<LoginRole, string>>;
  readonly slotDir: string;
  readonly vaultDir: string;
  readonly goldenDir: string;
}

export function slotNames(ref: SlotRef, root: string = DEFAULT_INSTALL_ROOT): SlotNames {
  return {
    database: databaseName(ref),
    alias: webAlias(ref),
    appPools: Object.fromEntries(APP_POOL_ROLES.map((role) => [role, appPoolName(ref, role)])) as Record<
      AppPoolRole,
      string
    >,
    service: agentServiceName(ref),
    agentPort: agentPort(ref),
    logins: { dbo: loginName(ref, "dbo"), reg: loginName(ref, "reg") },
    slotDir: slotDir(ref, root),
    vaultDir: vaultDir(ref, root),
    goldenDir: goldenDir(ref.flavor, root),
  };
}
