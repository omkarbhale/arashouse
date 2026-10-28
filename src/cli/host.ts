// Which host driver the CLI talks to. `ARASHOUSE_HOST=fake` selects the fake host (the CLI tests use
// it); otherwise `BrokerHost`, which reaches the broker on Windows through the Windows `node.exe`
// (`ARASHOUSE_WINDOWS_NODE` overrides where it is). Until the broker is installed (ticket 21) every
// host call fails as unreachable with a hint, and so do the verbs it does not have yet. Commands that
// need no host (`status`, `return`, `run`) work either way; a reset and the operator commands need it
// (with the broker missing, a slot stays dirty until it is there).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FLAVOR_KEYS, type FlavorKey } from "../core/flavors.js";
import { DEFAULT_INSTALL_ROOT, databaseName, goldenLayout } from "../core/names.js";
import { LeaseFileStore } from "../core/lease-files.js";
import { UsageError, type LeaseHost } from "../core/lease.js";
import type { OperatorHost } from "../core/operator.js";
import type { GoldenSet } from "../core/reset.js";
import { StateCorruptError } from "../core/state.js";
import type { StateStore } from "../core/store.js";
import { BrokerHost } from "../host/broker-host.js";
import { DEFAULT_WINDOWS_NODE, WINDOWS_NODE_ENV, interopTransport } from "../host/broker-transport.js";
import type { HostDriver } from "../host/driver.js";
import { HostError } from "../host/errors.js";
import { LiveClock } from "../host/clock.js";
import { FakeHost, type Fault } from "../host/fake.js";
import { HOST_ADDR_ENV, hostAddress, slotUrl } from "../host/url.js";
import { wslPathOf } from "./setup.js";

export const HOST_ENV = "ARASHOUSE_HOST";

/** With the fake host: a JSON array of `Fault`s to inject (test seam), for example a `readStamp` that fails `Unreachable`. */
export const FAKE_FAULTS_ENV = "ARASHOUSE_FAKE_FAULTS";

/** The host calls the CLI makes (`backupDatabase` for `extract db`, ticket 43). */
export type CliHost = LeaseHost & OperatorHost & Pick<HostDriver, "backupDatabase">;

export interface SelectedHost {
  readonly kind: "fake" | "broker";
  readonly host: CliHost;
  /** The URL of a slot as seen from WSL, from its web alias. */
  readonly resolveUrl: (alias: string) => Promise<string>;
  /** The flavor's golden tree and backup, for a reset (tickets 28, 30 and 31). */
  readonly golden: (flavor: FlavorKey) => Promise<GoldenSet>;
  /** The install root, as a Windows path. */
  readonly root: string;
  /** The path this process opens for a Windows path under the root (`/mnt/c/...` on the host), for `extract` (ticket 43). */
  readonly toLocal: (windowsPath: string) => string;
}

export function hostKind(env: NodeJS.ProcessEnv): "fake" | "broker" {
  const value = env[HOST_ENV];
  if (value === undefined || value === "" || value === "broker") return "broker";
  if (value === "fake") return "fake";
  throw new UsageError(`${HOST_ENV} must be "fake" or "broker" (the default)`);
}

/** Where the fake host's install root is on this machine: `fake-host` in the state folder. */
export function fakeRootDir(home: string): string {
  return join(home, "fake-host");
}

/** Maps a Windows path under `root` to the same path under `dir`; anything else is refused. */
function mappedPath(root: string, dir: string): (windowsPath: string) => string {
  const prefix = `${root.toLowerCase()}\\`;
  return (windowsPath) => {
    if (windowsPath.toLowerCase() === root.toLowerCase()) return dir;
    if (!windowsPath.toLowerCase().startsWith(prefix)) throw new Error(`"${windowsPath}" is not under ${root}`);
    return join(dir, ...windowsPath.slice(prefix.length).split("\\"));
  };
}

/**
 * The fake host, rebuilt in every process from the state file: each slot the state holds is
 * provisioned clean (none when the file is unusable), a leased slot's stamp names its lease, every flavor's baseline is
 * built, and the faults in `ARASHOUSE_FAKE_FAULTS` are injected. Its URLs use `ARASHOUSE_HOST_ADDR`, else
 * `127.0.0.1`, and are never probed. Its install root is `fakeRootDir` (the tests put a slot's files there), and a
 * database backup it stages is a small text file.
 */
async function fakeHost(env: NodeJS.ProcessEnv, store: StateStore): Promise<SelectedHost> {
  const toLocal = mappedPath(DEFAULT_INSTALL_ROOT, fakeRootDir(store.paths.home));
  // On the system clock, as the state is: a reset's stamp is then never older than the lease it follows.
  const host = new FakeHost({
    baselines: FLAVOR_KEYS,
    clock: new LiveClock(),
    writeBackup: (staged, slot) => {
      mkdirSync(dirname(toLocal(staged)), { recursive: true });
      writeFileSync(toLocal(staged), `fake COPY_ONLY backup of ${databaseName(slot)}\n`, { flag: "wx" });
    },
  });
  // An unusable state file provisions nothing, so `doctor` can still report it.
  const slots = await store.read().then((state) => Object.values(state.slots), (err: unknown) => {
    if (err instanceof StateCorruptError) return [];
    throw err;
  });
  for (const slot of slots) {
    const ref = { flavor: slot.flavor, slot: slot.number };
    await host.provisionSlot(ref);
    if (slot.status === "leased" && slot.lease) {
      const stamp = (await host.readStamp(ref)).stamp;
      if (stamp) await host.writeStamp(ref, { ...stamp, leaseId: slot.lease.lease_id });
    }
  }
  const faults = env[FAKE_FAULTS_ENV];
  if (faults !== undefined && faults !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(faults);
    } catch {
      throw new UsageError(`${FAKE_FAULTS_ENV} must be a JSON array of faults`);
    }
    if (!Array.isArray(parsed)) throw new UsageError(`${FAKE_FAULTS_ENV} must be a JSON array of faults`);
    for (const fault of parsed as Fault[]) host.injectFault(fault);
  }
  const address = env[HOST_ADDR_ENV]?.trim() || "127.0.0.1";
  return {
    kind: "fake",
    host,
    resolveUrl: async (alias) => slotUrl(address, alias),
    golden: async (flavor) => ({ tree: host.golden(flavor), backup: host.backup(flavor) }),
    root: DEFAULT_INSTALL_ROOT,
    toLocal,
  };
}

/**
 * The flavor's golden as the broker names it (tickets 28, 30 and 31): the golden folder verified against its own manifest
 * (`golden` level), its manifest hash for the tree, and `db\ootb.bak` for the backup. A golden that does not verify, or is
 * not built, is `Retryable`, so the reset gives the slot back as dirty rather than quarantining it.
 */
async function brokerGolden(host: BrokerHost, flavor: FlavorKey): Promise<GoldenSet> {
  const verified = await host.baselineVerify(flavor, { level: "golden" });
  if (!verified.ok || verified.goldenHash === undefined) throw new HostError("Retryable", verified.detail);
  return { tree: { flavor, hash: verified.goldenHash }, backup: { flavor, file: goldenLayout(flavor).ootbBackup, hash: verified.goldenHash } };
}

export async function selectHost(env: NodeJS.ProcessEnv, store: StateStore): Promise<SelectedHost> {
  if (hostKind(env) === "fake") return fakeHost(env, store);
  const node = env[WINDOWS_NODE_ENV]?.trim() || DEFAULT_WINDOWS_NODE;
  // The lease's password is looked up in the lease-file store by its handle and sent to the broker (ticket 34).
  const host = new BrokerHost(interopTransport({ node }), { secrets: new LeaseFileStore(store.paths.home) });
  return {
    kind: "broker",
    host,
    resolveUrl: async (alias) => slotUrl(await hostAddress(alias, { env }), alias),
    golden: (flavor) => brokerGolden(host, flavor),
    root: DEFAULT_INSTALL_ROOT,
    toLocal: wslPathOf,
  };
}
