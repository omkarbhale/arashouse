// The broker's `storeOotbRoot` verb (ticket 35, docs/health.md): the password `root` has in a flavor's golden backup,
// stored as `ootb-root-<key>` in the host's DPAPI store. A restore brings that password back, and the health check of
// every reset logs in with it once to make the free slot's random one (ticket 32). No WSL caller sends it: the
// elevated `scripts/store-ootb-root.ps1` reads it from a file only the captain's Windows user can decrypt and sends it
// on the request line. It is a Secret from the moment it is read, so `redact` replaces it; the answer names the flavor.

import { FLAVOR_KEYS, type FlavorKey } from "../core/flavors.js";
import { ootbRootSecretName } from "../core/names.js";
import { Secret } from "../core/secret.js";
import type { SecretStore } from "../core/secret-store.js";
import type { Broker, VerbContext } from "./broker.js";
import { ProtocolError, type WireResult } from "./protocol.js";

export interface StoreOotbRootArgs {
  readonly flavor: FlavorKey;
  readonly password: Secret;
}

/** An Aras password of any printable text, as a golden backup may hold one. */
const PASSWORD = /^[\x20-\x7e]{1,128}$/;

/** `{ flavor, password }`. A refusal names a field, never a value. */
export function parseStoreOotbRootArgs(args: Readonly<Record<string, unknown>>): StoreOotbRootArgs {
  // Wrapped before anything else is checked, so `redact` replaces it in every refusal below.
  const raw = args.password;
  const password = typeof raw === "string" && raw.length > 0 ? Secret.of(raw, "aras-login") : undefined;
  for (const key of Object.keys(args)) {
    if (key !== "flavor" && key !== "password") throw new ProtocolError(`storeOotbRoot takes only "flavor" and "password", not "${key.slice(0, 32)}"`);
  }
  const { flavor } = args;
  if (typeof flavor !== "string" || !(FLAVOR_KEYS as readonly string[]).includes(flavor)) {
    throw new ProtocolError(`storeOotbRoot needs a flavor: ${FLAVOR_KEYS.join(", ")}`);
  }
  if (password === undefined) throw new ProtocolError("storeOotbRoot needs the password as a string");
  if (!PASSWORD.test(raw as string)) throw new ProtocolError("storeOotbRoot: the password must be 1 to 128 printable ASCII characters");
  return { flavor: flavor as FlavorKey, password };
}

/** Stores the flavor's golden backup `root` password, replacing the one stored before. */
export async function storeOotbRoot(store: SecretStore, args: StoreOotbRootArgs): Promise<WireResult> {
  await store.put(ootbRootSecretName(args.flavor), args.password);
  return { ok: true, detail: `stored the golden backup's root password for ${args.flavor}`, flavor: args.flavor };
}

/** Registers `storeOotbRoot` on `broker`, storing into `store` (the host's DPAPI store, or a test double). */
export function registerOotbRootVerb(broker: Broker, store: SecretStore): Broker {
  return broker.register("storeOotbRoot", {
    target: "none",
    args: parseStoreOotbRootArgs,
    run: (ctx: VerbContext) => storeOotbRoot(store, ctx.args as StoreOotbRootArgs),
  });
}
