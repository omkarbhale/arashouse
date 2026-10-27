// The host-side secret store (ticket 23's `SecretStore` contract): machine-scope DPAPI blobs at
// `<root>\secrets\<name>.bin`, readable only through that folder's ACL (SYSTEM and the broker,
// ticket 21). Node has no DPAPI, so each call is one `slot-steps.ps1` step: the value travels only
// on that process's stdin (a put) or stdout (a get), never in an argument list or a log.

import { assertSecretName, type SecretStore } from "../core/secret-store.js";
import { Secret, type SecretKind } from "../core/secret.js";
import type { SlotStep } from "./slot-steps.js";

/** Runs one secret step of `slot-steps.ps1` with its request on stdin. */
export type SecretStepRunner = (step: Extract<SlotStep, "secret-put" | "secret-get" | "secret-delete">, request: object) => Promise<Record<string, unknown>>;

/**
 * The kind of the secret a stored name holds: `licence-<line>` a licence key, `slot-<key>-<NN>-dbo|reg` a slot's SQL login
 * password, `slot-<key>-<NN>-root` a free slot's Aras `root` password and `ootb-root-<key>` the one its golden backup holds.
 */
export function storedSecretKind(name: string): SecretKind {
  if (/^licence-/.test(name)) return "licence";
  if (/^slot-[a-z0-9]+-\d{2}-(dbo|reg)$/.test(name)) return "sql-login";
  if (/^slot-[a-z0-9]+-\d{2}-root$/.test(name) || /^ootb-root-[a-z0-9]+$/.test(name)) return "aras-login";
  throw new Error(`no stored secret is named like "${name}"`);
}

export function dpapiSecretStore(run: SecretStepRunner): SecretStore {
  const get = async (name: string): Promise<Secret | undefined> => {
    const kind = storedSecretKind(assertSecretName(name));
    const answer = await run("secret-get", { name });
    if (answer.found !== true) return undefined;
    if (typeof answer.value !== "string") throw new Error(`the stored secret ${name} is unreadable`);
    return Secret.of(answer.value, kind);
  };
  return {
    get,
    has: async (name) => (await get(name)) !== undefined,
    async put(name, secret) {
      if (secret.kind !== storedSecretKind(assertSecretName(name))) throw new Error(`the secret stored as ${name} must be a ${storedSecretKind(name)} secret`);
      await run("secret-put", { name, value: secret.reveal() });
    },
    async delete(name) {
      assertSecretName(name);
      return (await run("secret-delete", { name })).deleted === true;
    },
  };
}
