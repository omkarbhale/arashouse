// The baseline build (ticket 24): what `arashouse baseline build <flavor>` makes, as data. Every name
// and path comes from names.ts; the MSI facts come from the spike record (section 1). The steps run
// on Windows, elevated (src/broker/baseline-build.ts); this file does no I/O.
//
// The build installs the flavor's MSI into a throw-away instance (`ah-build-<key>`, database
// `arashouse_build_<key>`), checks it serves, copies its tree and database into `golden\<key>`, then
// removes the instance. Golden is immutable: only another build, with `--replace`, changes it.

import { win32 } from "node:path";
import { FLAVORS, getFlavor, type FlavorKey, type HostPrerequisite } from "./flavors.js";
import {
  BROKER_SERVICE_NAME,
  DEFAULT_INSTALL_ROOT,
  buildNames,
  buildScratch,
  databaseFiles,
  goldenLayout,
  goldenLayoutAt,
  type BuildNames,
  type BuildScratch,
  type GoldenLayout,
} from "./names.js";

/** The steps, in the order they run. A failure from `msi-copy` on, the first that changes the host, removes the throw-away instance. */
export const BUILD_STEPS = [
  "preflight",
  "snapshot",
  "msi-copy",
  "msi-cost",
  "install",
  "pools",
  "database",
  "configure",
  "verify",
  "stop",
  "blank-secrets",
  "capture-tree",
  "capture-db",
  "metadata",
  "manifest",
  "promote",
  "remove",
  "deny-list",
  "seal",
] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

/** The bundle's media folder holds the flavor's MSI and backups under these names (the registry's). */
export interface BuildMedia {
  readonly msi: string;
  readonly core: string;
  readonly coreAndSolutions: string;
}

export interface BaselinePlan {
  readonly flavor: FlavorKey;
  readonly root: string;
  /** The build the installed `Aras.Server.Core.dll` must read; null when the registry does not know it yet. */
  readonly serverBuild: string | null;
  readonly names: BuildNames;
  readonly scratch: BuildScratch;
  /** The build database's files under `sqldata\`. */
  readonly databaseFiles: { readonly data: string; readonly log: string };
  /** Where the build's `COPY_ONLY` backup is written first: SQL Server may write `sqldata\`, not `golden\`. */
  readonly backupScratch: string;
  readonly golden: GoldenLayout;
  /** The new golden, assembled under `golden-build\<key>.golden` and moved into `golden\<key>` last. */
  readonly candidate: GoldenLayout;
  readonly media: BuildMedia;
  /** The MSI the bundle carries, by SHA-256 (recorded in `flavor.json`). */
  readonly msiSha256: string;
  /** Replace an existing golden (`--replace`); without it a build refuses one. */
  readonly replace: boolean;
  readonly prerequisites: readonly HostPrerequisite[];
  /** The import-export-libs-js engine the engine check exports with (`--engine`). */
  readonly libsJsEngine: string;
}

export interface PlanOptions {
  readonly root?: string;
  readonly msiSha256: string;
  readonly replace?: boolean;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Every name and path a build of `flavor` uses, derived from the flavor alone. */
export function baselinePlan(flavor: FlavorKey, options: PlanOptions): BaselinePlan {
  const f = getFlavor(flavor);
  const root = options.root ?? DEFAULT_INSTALL_ROOT;
  if (!SHA256.test(options.msiSha256)) throw new Error("the MSI's SHA-256 must be 64 lower-case hex digits");
  const names = buildNames(flavor, root);
  const scratch = buildScratch(flavor, root);
  const mediaDir = win32.join(scratch.bundleDir, "media");
  return {
    flavor,
    root,
    serverBuild: f.serverBuild,
    names,
    scratch,
    databaseFiles: databaseFiles(names.database, root),
    backupScratch: win32.join(root, "sqldata", `${names.database}-ootb.bak`),
    golden: goldenLayout(flavor, root),
    candidate: goldenLayoutAt(scratch.candidateDir),
    media: {
      msi: win32.join(mediaDir, f.msiName),
      core: win32.join(mediaDir, f.backups.core),
      coreAndSolutions: win32.join(mediaDir, f.backups.coreAndSolutions),
    },
    msiSha256: options.msiSha256,
    replace: options.replace ?? false,
    prerequisites: f.hostPrerequisites,
    libsJsEngine: f.libsJsEngine,
  };
}

/**
 * The MSI's public properties for the unattended install (spike record, section 1), none of them
 * secret. `INSTALLDIR` and `VAULT_ROOT` are Directory-table keys and always set: omitted, the MSI
 * installs into Program Files and `C:\Aras\Vault`. No database (`INSTALL_DATABASE=0`: the build
 * restores the shipped backup itself), no agent, no restart, Windows authentication.
 */
export function msiInstallProperties(plan: BaselinePlan): Readonly<Record<string, string>> {
  return {
    INSTALLDIR: plan.names.dir,
    VAULT_ROOT: plan.scratch.vaultRoot,
    WEBALIAS: plan.names.alias,
    INSTALL_DATABASE: "0",
    INSTALL_AGENT_SERVICE: "0",
    IS_SQLSERVER_SERVER: "(local)",
    IS_SQLSERVER_DATABASE: plan.names.database,
    IS_SQLSERVER_AUTHENTICATION: "0",
    SQL_SERVER_LOGIN_NAME: plan.scratch.logins.dbo,
    SQL_SERVER_LOGIN_REGULAR_NAME: plan.scratch.logins.reg,
    REBOOT: "ReallySuppress",
    MSIRESTARTMANAGERCONTROL: "Disable",
  };
}

/** Properties Windows Installer itself defines: not rows of the MSI's Property table, so `media check` cannot list them. */
export const MSI_BUILT_IN_PROPERTIES: readonly string[] = ["INSTALLDIR", "VAULT_ROOT", "REBOOT", "MSIRESTARTMANAGERCONTROL"];

/**
 * Kept out of the MSI log by `MsiHiddenProperties`. The build passes none of them, but the MSI's own
 * custom actions generate the OAuth certificates' password and read the SQL ones; the log is deleted
 * anyway (it can still hold them).
 */
export const MSI_HIDDEN_PROPERTIES: readonly string[] = [
  "LICENSEKEY",
  "IS_SQLSERVER_PASSWORD",
  "SQL_SERVER_LOGIN_PASSWORD",
  "SQL_SERVER_LOGIN_REGULAR_PASSWORD",
  "OAUTH_CERTIFICATES_PASSWORD",
];

/** The users the shipped backups hold, which the build maps to its own logins (spike record, section 4). */
export const SHIPPED_DATABASE_USERS = { dbo: "innovator", reg: "innovator_regular" } as const;

/** The Aras login the build checks with: the shipped backup's administrator. */
export const SHIPPED_ADMIN_LOGIN = "root";

/**
 * The item the engine check exports (`aras-pkg export <out> <item>`): the shipped ItemType `Part`, whose id is
 * the same in every release's backup (spike 07 exported it from Release 23).
 */
export const ENGINE_CHECK_ITEM = "ItemType:4F1AC04A2B484F3ABA4E20DB63808A88";

/** The bundle folder that holds the import-export-libs-js CLI for the engine check, when the bundle carries one. */
export const ENGINE_BUNDLE_DIR = "engine";

// ---- what the build records ---------------------------------------------------------------------

/** One IIS application of the build alias, as `iis.json` records it (ticket 25 makes slot pools from it). */
export interface IisApplication {
  /** Under the alias: `""` for the alias itself, `/Client`, `/Server`, ... */
  readonly subPath: string;
  /** Relative to the install directory, backslash-separated. */
  readonly physicalPath: string;
  /** The role in the pool name `<alias>-<role>`. */
  readonly role: string;
  readonly pool: {
    readonly managedRuntimeVersion: string;
    readonly pipelineMode: string;
    readonly enable32Bit: boolean;
    readonly identityType: string;
    readonly idleTimeout: string;
    readonly startMode: string;
  };
}

/** `iis.json` */
export interface IisRecord {
  readonly schema: 1;
  readonly site: string;
  readonly applications: readonly IisApplication[];
}

/** `service.json`: the agent service, or that the build installed none (`INSTALL_AGENT_SERVICE=0`). */
export interface ServiceRecord {
  readonly schema: 1;
  readonly installed: boolean;
  readonly name: string | null;
  readonly binaryPath: string | null;
  readonly startMode: string | null;
}

/** `flavor.json` */
export interface FlavorRecord {
  readonly schema: 1;
  readonly flavor: FlavorKey;
  readonly release: string;
  readonly serverBuild: string;
  readonly msiSha256: string;
  readonly msiProductVersion: string;
  readonly builtAt: string;
  readonly buildSeconds: number;
  readonly hostPrerequisites: readonly HostPrerequisite[];
  readonly tree: { readonly files: number; readonly bytes: number };
  readonly backups: readonly { readonly file: string; readonly bytes: number; readonly sha256: string }[];
  /** The manifest hash of `tree\`: the golden hash slot stamps carry. */
  readonly manifestHash: string;
  /**
   * The owner of the database `db\ootb.bak` was taken from: the broker's login (`OOTB_OWNER`), so a slot restored from it
   * is the broker's inside as well (ticket 25). Absent in a golden built before that: provisioning refuses it.
   */
  readonly ootbOwner?: string;
}

/** The SQL login `ootb.bak`'s database belongs to: the broker's (ticket 22), which restores and maps every slot. */
export const OOTB_OWNER = `NT SERVICE\\${BROKER_SERVICE_NAME}`;

export function flavorRecord(
  plan: BaselinePlan,
  facts: Omit<FlavorRecord, "schema" | "flavor" | "release" | "msiSha256" | "msiProductVersion" | "hostPrerequisites" | "ootbOwner">,
): FlavorRecord {
  const f = FLAVORS[plan.flavor];
  return {
    schema: 1,
    flavor: plan.flavor,
    release: f.release,
    serverBuild: facts.serverBuild,
    msiSha256: plan.msiSha256,
    msiProductVersion: f.msiProductVersion,
    builtAt: facts.builtAt,
    buildSeconds: facts.buildSeconds,
    hostPrerequisites: plan.prerequisites,
    tree: facts.tree,
    backups: facts.backups,
    manifestHash: facts.manifestHash,
    ootbOwner: OOTB_OWNER,
  };
}

/** Two-space JSON with a trailing newline, as every golden record is written. */
export function goldenJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---- the deny-list self-check -------------------------------------------------------------------

/**
 * The deny-list objects as the build sees them: each name maps to a fingerprint of what it is (a hash
 * of its properties, never its content or a secret). Taken before the build and again after it.
 */
export type DenyListSnapshot = Readonly<Record<string, string>>;

export interface DenyListDiff {
  readonly ok: boolean;
  readonly changed: readonly string[];
  readonly missing: readonly string[];
  readonly added: readonly string[];
}

/** Names only: which deny-list objects changed, disappeared or appeared between two snapshots. */
export function compareDenyList(before: DenyListSnapshot, after: DenyListSnapshot): DenyListDiff {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [name, print] of Object.entries(before)) {
    if (!(name in after)) missing.push(name);
    else if (after[name] !== print) changed.push(name);
  }
  const added = Object.keys(after).filter((name) => !(name in before));
  const sort = (a: string[]) => a.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return { ok: changed.length + missing.length + added.length === 0, changed: sort(changed), missing: sort(missing), added: sort(added) };
}

// ---- the result ---------------------------------------------------------------------------------

export type StepStatus = "ok" | "skipped" | "failed";

export interface StepRecord {
  readonly step: BuildStep;
  readonly status: StepStatus;
  readonly seconds: number;
  /** One line, never a secret. */
  readonly detail: string;
}

/** What `baseline-build.ps1` prints last and writes to the bundle's `result.json`. */
export interface BuildReport {
  readonly ok: boolean;
  readonly flavor: FlavorKey;
  readonly startedAt: string;
  readonly seconds: number;
  readonly steps: readonly StepRecord[];
  /** The manifest hash of the new golden, once it is in place. */
  readonly goldenHash: string | null;
  /** Whether the login check ran: it needs the line's licence key and the shipped admin password. */
  readonly loginChecked: boolean;
  /**
   * Whether the engine check ran and passed: a one-item `aras-pkg export` with the flavor's libs-js engine. It
   * needs the login's secrets and a bundle written with `--engine-check`.
   */
  readonly engineChecked: boolean;
  /** The first failure, one line. */
  readonly error: string | null;
  /** What the cleanup after a failure did not manage to remove (names only). */
  readonly leftovers: readonly string[];
}
