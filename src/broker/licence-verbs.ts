// The broker's `storeLicence` verb (ticket 34b, docs/secrets.md): the whole `<License>` element of one licence line
// (`lic_key`, `act_key`, `lic_type`, `company`) stored as one machine-scope DPAPI blob, `<root>\secrets\licence-<line>.bin`,
// which a provision and every reset render into the slot's config. No WSL caller sends it: the captain's elevated
// `scripts/store-licence.ps1` reads the element from an existing install's config and sends it on the request line.
// The values are Secrets from the moment they are read, so `redact` replaces each; the answer names the line only.

import { licenceElement, encodeLicence, licenceLines, licenceSecretName, type LicenceElement } from "../core/licence.js";
import type { SecretStore } from "../core/secret-store.js";
import type { Broker, VerbContext } from "./broker.js";
import { ProtocolError, type WireResult } from "./protocol.js";

export interface StoreLicenceArgs {
  readonly line: string;
  readonly licence: LicenceElement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ line, licence: { lic_key, act_key, lic_type, company } }`. A refusal names a field, never a value. */
export function parseStoreLicenceArgs(args: Readonly<Record<string, unknown>>): StoreLicenceArgs {
  for (const key of Object.keys(args)) {
    if (key !== "line" && key !== "licence") throw new ProtocolError(`storeLicence takes only "line" and "licence", not "${key.slice(0, 32)}"`);
  }
  const { line, licence } = args;
  if (typeof line !== "string" || !licenceLines().includes(line)) throw new ProtocolError(`storeLicence needs a licence line: ${licenceLines().join(" or ")}`);
  if (!isRecord(licence)) throw new ProtocolError("storeLicence needs the licence as { lic_key, act_key, lic_type, company }");
  try {
    return { line, licence: licenceElement(licence) };
  } catch (err) {
    throw new ProtocolError(`storeLicence: ${(err as Error).message}`);
  }
}

/** Stores the line's licence, replacing the one stored before. */
export async function storeLicence(store: SecretStore, args: StoreLicenceArgs): Promise<WireResult> {
  await store.put(licenceSecretName(args.line), encodeLicence(args.licence));
  return { ok: true, detail: `stored the licence for line ${args.line}`, line: args.line };
}

/** Registers `storeLicence` on `broker`, storing into `store` (the host's DPAPI store, or a test double). */
export function registerLicenceVerbs(broker: Broker, store: SecretStore): Broker {
  return broker.register("storeLicence", {
    target: "none",
    args: parseStoreLicenceArgs,
    run: (ctx: VerbContext) => storeLicence(store, ctx.args as StoreLicenceArgs),
  });
}
