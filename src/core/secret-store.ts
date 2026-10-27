// The contracts a secret needs: where it persists, and how it is asked for. Neither does any I/O
// here. The host side persists with machine-scope DPAPI under `<root>\secrets\` (the broker, tickets
// 20 and 21); the WSL side asks at a no-echo TTY read (src/cli/tty.ts). Tests use the in-memory store.

import { isSecretName } from "./names.js";
import { Secret } from "./secret.js";

/** Persistent secrets by name (`licence-14`). Absence is `undefined` or `false`, never an error. */
export interface SecretStore {
  has(name: string): Promise<boolean>;
  get(name: string): Promise<Secret | undefined>;
  put(name: string, secret: Secret): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** Asks a person for a secret without echoing it. */
export interface HiddenPrompter {
  /** True only when a person can answer (a TTY on both ends). */
  readonly interactive: boolean;
  /** Show `question`, read one line without echo, and wrap it. The answer may be empty. */
  promptSecret(question: string, kind: Secret["kind"]): Promise<Secret>;
}

export function assertSecretName(name: string): string {
  if (!isSecretName(name)) throw new Error("secret name must be 1 to 64 lower-case letters, digits or '-'");
  return name;
}

/** An in-memory store: the test double for the DPAPI store, and for the fake host (ticket 12). */
export class MemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, Secret>();

  get size(): number {
    return this.#secrets.size;
  }

  async has(name: string): Promise<boolean> {
    return this.#secrets.has(assertSecretName(name));
  }

  async get(name: string): Promise<Secret | undefined> {
    return this.#secrets.get(assertSecretName(name));
  }

  async put(name: string, secret: Secret): Promise<void> {
    this.#secrets.set(assertSecretName(name), secret);
  }

  async delete(name: string): Promise<boolean> {
    return this.#secrets.delete(assertSecretName(name));
  }
}
