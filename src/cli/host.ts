// Which host driver the CLI talks to. `ARASHOUSE_HOST=fake` selects the fake host (the CLI tests use
// it); otherwise the broker on Windows, whose client does not exist yet (tickets 20 and 21), so every
// host call fails as unreachable with a hint. Commands that need no host (`status`, `return`, `run`)
// work either way; a reset and the operator commands need it (with the broker missing, a slot stays
// dirty until it is there).

import { FLAVOR_KEYS, type FlavorKey } from "../core/flavors.js";
import { UsageError, type LeaseHost } from "../core/lease.js";
import type { OperatorHost } from "../core/operator.js";
import type { GoldenSet } from "../core/reset.js";
import { StateCorruptError } from "../core/state.js";
import type { StateStore } from "../core/store.js";
import { HostError } from "../host/errors.js";
import { FakeHost, type Fault } from "../host/fake.js";
import { HOST_ADDR_ENV, hostAddress, slotUrl } from "../host/url.js";

export const HOST_ENV = "ARASHOUSE_HOST";

/** With the fake host: a JSON array of `Fault`s to inject (test seam), for example a `readStamp` that fails `Unreachable`. */
export const FAKE_FAULTS_ENV = "ARASHOUSE_FAKE_FAULTS";

/** The host calls the CLI makes. */
export type CliHost = LeaseHost & OperatorHost;

export interface SelectedHost {
  readonly kind: "fake" | "broker";
  readonly host: CliHost;
  /** The URL of a slot as seen from WSL, from its web alias. */
  readonly resolveUrl: (alias: string) => Promise<string>;
  /** The flavor's golden tree and backup, for a reset (tickets 28, 30 and 31). */
  readonly golden: (flavor: FlavorKey) => Promise<GoldenSet>;
}

export function hostKind(env: NodeJS.ProcessEnv): "fake" | "broker" {
  const value = env[HOST_ENV];
  if (value === undefined || value === "" || value === "broker") return "broker";
  if (value === "fake") return "fake";
  throw new UsageError(`${HOST_ENV} must be "fake" or "broker" (the default)`);
}

/**
 * The fake host, rebuilt in every process from the state file: each slot the state holds is
 * provisioned clean (none when the file is unusable), every flavor's baseline is built, and the
 * faults in `ARASHOUSE_FAKE_FAULTS` are injected. Its URLs use `ARASHOUSE_HOST_ADDR`, else
 * `127.0.0.1`, and are never probed.
 */
async function fakeHost(env: NodeJS.ProcessEnv, store: StateStore): Promise<SelectedHost> {
  const host = new FakeHost({ baselines: FLAVOR_KEYS });
  // An unusable state file provisions nothing, so `doctor` can still report it.
  const slots = await store.read().then((state) => Object.values(state.slots), (err: unknown) => {
    if (err instanceof StateCorruptError) return [];
    throw err;
  });
  for (const slot of slots) await host.provisionSlot({ flavor: slot.flavor, slot: slot.number });
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
  };
}

const NO_BROKER = "the arashouse broker is not installed on Windows yet (arashouse setup, tickets 20 and 21)";

function unavailable(): Promise<never> {
  return Promise.reject(new HostError("Unreachable", NO_BROKER));
}

/** Stands in for the broker client until it exists: every call fails `Unreachable`. */
const brokerHost: CliHost = {
  hostInfo: unavailable,
  readStamp: unavailable,
  writeStamp: unavailable,
  healthCheck: unavailable,
  setLeaseCredentials: unavailable,
  baselineVerify: unavailable,
  quiesce: unavailable,
  resetDatabase: unavailable,
  resetTree: unavailable,
  startSlot: unavailable,
  stopSlot: unavailable,
  ping: unavailable,
  listSlots: unavailable,
  provisionSlot: unavailable,
  destroySlot: unavailable,
};

export async function selectHost(env: NodeJS.ProcessEnv, store: StateStore): Promise<SelectedHost> {
  if (hostKind(env) === "fake") return fakeHost(env, store);
  return {
    kind: "broker",
    host: brokerHost,
    resolveUrl: async (alias) => slotUrl(await hostAddress(alias, { env }), alias),
    golden: unavailable,
  };
}
