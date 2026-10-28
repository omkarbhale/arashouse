// The host-driver contract: every effect on Windows goes through this one interface, so the lease
// and reset logic is tested without Windows. `FakeHost` (fake.ts) implements it for offline tests;
// `BrokerHost` (the broker client, tickets 20 and the verb tickets) implements it on the real host.
//
// Rules every implementation keeps:
// - Each call takes a resolved slot record (or a flavor), never a user string, and runs the guards
//   first (`assertSlotOwned` and friends in owned.ts). A refusal is a `Refused` HostError.
// - Each call returns `{ ok, ms, detail }` or throws a `HostError`. Nothing else escapes.
// - No call takes, returns or logs a secret as a string. A secret is a `SecretRef` handle.

import type { FlavorKey } from "../core/flavors.js";
import type { LicenceStatus } from "../core/licence.js";
import type { ManifestDiff, VerifyLevel } from "../core/manifest.js";
import type { SlotRef } from "../core/names.js";

/** What every successful call returns. `detail` is one line for a log; it never holds a secret. */
export interface HostResult {
  readonly ok: boolean;
  /** How long the call took, by the driver's clock. */
  readonly ms: number;
  readonly detail: string;
}

/**
 * A handle to a secret in the secret store (ticket 23). The secret itself never travels through a
 * host call: the host dereferences the handle on its own side. Ticket 23 may replace this with its
 * own handle type; it must stay an opaque value that is safe to log.
 */
export interface SecretRef {
  readonly secretRef: string;
}

/** The broker's SQL login as it reads itself (ticket 22): the doctor needs it in neither `sysadmin` nor `dbcreator`. */
export interface SqlLoginInfo {
  /** `SUSER_SNAME()`: `NT SERVICE\ArasHouseBroker` once `setup-sql.ps1` has run. */
  readonly login: string;
  readonly sysadmin: boolean;
  readonly dbcreator: boolean;
  /** How many of the `arashouse_admin` procedures it may execute (all five once `setup-sql.ps1` has run). */
  readonly procedures: number;
}

export interface HostInfo {
  readonly os: string;
  readonly freeRamMb: number;
  /** Free disk at the install root. */
  readonly freeDiskGb: number;
  readonly brokerVersion: string;
  readonly sqlReachable: boolean;
  /** The broker's SQL login; null when it cannot connect, absent from a broker older than ticket 22. */
  readonly sqlLogin?: SqlLoginInfo | null;
  /** Whether a licence is stored for each licence line: booleans only (ticket 34b); absent from an older broker. */
  readonly licences?: readonly LicenceStatus[];
}

export interface HostInfoResult extends HostResult {
  readonly info: HostInfo;
}

/**
 * The slot stamp (`.arashouse-slot.json` in the slot folder, ticket 11): what recovery and `doctor`
 * read back. It holds no secret.
 */
export interface SlotStamp {
  /** `<key>-<NN>`, as `slotId` builds it. */
  readonly slotId: string;
  readonly flavor: FlavorKey;
  /** The golden manifest hash the slot was last reset to; null before the first reset. */
  readonly goldenHash: string | null;
  /** ISO time of the last reset; null before the first reset. */
  readonly lastResetAt: string | null;
  /** The lease id, while the slot is leased. */
  readonly leaseId?: string | null;
}

export interface StampResult extends HostResult {
  /** Null when the slot folder has no stamp. */
  readonly stamp: SlotStamp | null;
}

export interface ListedSlot {
  readonly slot: SlotRef;
  readonly stamp: SlotStamp | null;
}

export interface ListSlotsResult extends HostResult {
  readonly slots: readonly ListedSlot[];
}

/** The golden code tree a slot is mirrored from. The host resolves its folder from the flavor. */
export interface GoldenRef {
  readonly flavor: FlavorKey;
  /** The golden manifest hash (ticket 28). */
  readonly hash: string;
}

/** A database backup inside the flavor's golden folder, and the golden hash it carries. */
export interface BackupRef {
  readonly flavor: FlavorKey;
  /** Absolute Windows path of the `.bak`, inside `golden\<key>\`. */
  readonly file: string;
  readonly hash: string;
}

export interface StartOptions {
  /** Start the slot's agent service as well (ticket 33). */
  readonly agent: boolean;
}

export interface HealthCheckEntry {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** How long the check took, where the host measures it. */
  readonly ms?: number;
}

/** The database marker as the health check read it back (ticket 32): what the last reset or provision wrote. */
export interface MarkerReading {
  /** `arashouse.golden_hash`; null when the database carries none. */
  readonly goldenHash: string | null;
  /** `arashouse.reset_at`, an ISO time; null when the database carries none. */
  readonly resetAt: string | null;
}

export interface HealthResult extends HostResult {
  readonly checks: readonly HealthCheckEntry[];
  /** The slot database's marker; null when the database could not be read, absent when the host does not report it. */
  readonly marker?: MarkerReading | null;
}

export interface BaselineBuildResult extends HostResult {
  /** The golden manifest hash the build produced. */
  readonly goldenHash: string;
}

export interface BaselineVerifyOptions {
  /** `golden` (the default) checks the golden folder; `full` hashes every file; `fast` is the reset-path check. */
  readonly level?: VerifyLevel;
}

export interface BaselineVerifyResult extends HostResult {
  readonly level: VerifyLevel;
  /** The golden manifest hash, when the manifest could be read: the hash a reset mirrors to (ticket 30). */
  readonly goldenHash?: string;
  /** What differs: paths and counts, never contents. Absent when the baseline is not built. */
  readonly diff?: ManifestDiff;
}

/** How a staged code tree is deployed onto a leased slot (ticket 40, docs/code-deploy.md). */
export interface DeployOptions {
  /** The lease the caller holds: the slot's stamp must name it, and the staged folder must be inside `staging\<lease_id>`. */
  readonly leaseId: string;
  /** Where the staged folder lands in the slot's tree, `/`-separated, "" for its top; `Innovator` when absent. */
  readonly subpath?: string;
  /** May overwrite or delete the secrets and identity files (`InnovatorServerConfig.xml`, `*.pfx`, ...). */
  readonly allowConfig?: boolean;
  /** May write `VaultServer\` and `OAuthServer\` as well as `Innovator\`. */
  readonly allowServers?: boolean;
  /** Start the slot's agent again after the deploy (the lease was taken with `get --agent`). */
  readonly agent?: boolean;
}

/** A deploy that ran: the files are in place. `ok: false` when the slot did not come back up after it (the warm-up failed). */
export interface DeployResult extends HostResult {
  readonly files: number;
  /** Files the `deploy.json` delete list removed (one that did not exist is not counted). */
  readonly deleted: number;
  /** Whether ASP.NET's temporary files of the alias were cleared (the deploy touched `Server\bin` or `Server\dll`). */
  readonly compiledCleared: boolean;
}

/** The host driver. Every method may throw `HostError`; see errors.ts. */
export interface HostDriver {
  ping(): Promise<HostResult>;
  hostInfo(): Promise<HostInfoResult>;

  /** Creates the slot's folders, database, application and agent from the flavor's templates (ticket 25). */
  provisionSlot(slot: SlotRef): Promise<HostResult>;
  /** Removes everything `provisionSlot` made (ticket 25). */
  destroySlot(slot: SlotRef): Promise<HostResult>;

  /** Stops the agent and takes the applications offline so the tree can be replaced (ticket 30). */
  quiesce(slot: SlotRef): Promise<HostResult>;
  /** Mirrors the golden tree over the slot's tree and writes a fresh stamp (ticket 30). */
  resetTree(slot: SlotRef, golden: GoldenRef): Promise<HostResult>;
  /** Restores the golden backup over the slot's database and fixes it up (ticket 31). */
  resetDatabase(slot: SlotRef, backup: BackupRef): Promise<HostResult>;
  /** Brings the applications online and warms them (tickets 32 and 33). */
  startSlot(slot: SlotRef, options: StartOptions): Promise<HostResult>;
  /** Stops the agent and takes the applications offline (ticket 33). */
  stopSlot(slot: SlotRef): Promise<HostResult>;

  /**
   * Overlays a code tree the leaseholder staged under `staging\<lease_id>` onto the leased slot's tree (ticket 40): the
   * slot quiesced, the files copied, its pools started again and warmed. A refusal changes nothing.
   */
  deployCode(slot: SlotRef, stagedPath: string, options: DeployOptions): Promise<DeployResult>;
  /** Restores a `.bak` the leaseholder staged under `staging\<lease_id>` (ticket 39). */
  restoreDatabase(slot: SlotRef, stagedBak: string): Promise<HostResult>;
  /** Backs the slot's database up to a path under `staging\<lease_id>` (ticket 43). */
  backupDatabase(slot: SlotRef, stagedPath: string): Promise<HostResult>;

  /** Whether the slot is serving and matches its stamp (ticket 32). `ok: false` is a result, not an error. */
  healthCheck(slot: SlotRef): Promise<HealthResult>;

  readStamp(slot: SlotRef): Promise<StampResult>;
  writeStamp(slot: SlotRef, stamp: SlotStamp): Promise<HostResult>;
  /** Every slot on the host that the tool owns, for recovery and `doctor`. */
  listSlots(): Promise<ListSlotsResult>;

  /** Sets the slot's per-lease Aras credentials from a secret-store handle (ticket 34). */
  setLeaseCredentials(slot: SlotRef, secretRef: SecretRef): Promise<HostResult>;

  /** Builds the flavor's golden baseline from its media (ticket 24). */
  baselineBuild(flavor: FlavorKey): Promise<BaselineBuildResult>;
  /** Verifies the flavor's golden baseline against its manifest (ticket 28). `ok: false` is a result. */
  baselineVerify(flavor: FlavorKey, options?: BaselineVerifyOptions): Promise<BaselineVerifyResult>;
}

/** Every method name, for fault injection and the call record. */
export const HOST_METHODS = [
  "ping",
  "hostInfo",
  "provisionSlot",
  "destroySlot",
  "quiesce",
  "resetTree",
  "resetDatabase",
  "startSlot",
  "stopSlot",
  "deployCode",
  "restoreDatabase",
  "backupDatabase",
  "healthCheck",
  "readStamp",
  "writeStamp",
  "listSlots",
  "setLeaseCredentials",
  "baselineBuild",
  "baselineVerify",
] as const satisfies readonly (keyof HostDriver)[];

export type HostMethod = (typeof HOST_METHODS)[number];

// Compile-time check: HOST_METHODS lists every method of HostDriver.
const _everyMethodListed: Exclude<keyof HostDriver, HostMethod> extends never ? true : never = true;
void _everyMethodListed;
