// The Secret value type. Seven kinds exist: the SQL `sa` password (ticket 22), licence keys
// (ticket 23), per-lease Aras passwords (ticket 34), a slot's SQL login passwords, which the
// config edit list writes into the slot's `InnovatorServerConfig.xml` (tickets 19 and 25), the
// broker's client token (ticket 20), and an Aras login that is not a lease's: the shipped backup's
// administrator password, which the baseline build logs in with (ticket 24), and a free slot's random
// `root` password (ticket 34), and the password of a slot's OAuth signing certificate, made new by every render of
// its configs (ticket 54). A Secret prints, serialises and inspects as
// `[redacted]`; the only way to read it is `reveal()`, which only the files in the allowlist of
// test/reveal-allowlist.test.ts may call. Secrets come from a hidden prompt or from the environment
// of a process started for that purpose, never from a flag.

import { inspect } from "node:util";
import { REDACTED, registerSecretValue } from "./redact.js";

export const SECRET_KINDS = ["sql-sa", "licence", "lease-password", "sql-login", "broker-token", "aras-login", "oauth-cert"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export class Secret {
  readonly kind: SecretKind;
  readonly #value: string;

  private constructor(value: string, kind: SecretKind) {
    this.#value = value;
    this.kind = kind;
    registerSecretValue(value);
    Object.freeze(this);
  }

  /** Wrap a value that has just been read from a hidden prompt, the environment or a store. */
  static of(value: string, kind: SecretKind): Secret {
    if (typeof value !== "string") throw new TypeError("a secret is a string");
    if (!(SECRET_KINDS as readonly string[]).includes(kind)) throw new TypeError("unknown secret kind");
    return new Secret(value, kind);
  }

  static isSecret(value: unknown): value is Secret {
    return value instanceof Secret;
  }

  get length(): number {
    return this.#value.length;
  }

  /** The value. Call it at the single site that hands the secret to the thing that needs it. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

export interface EnvSecretOptions {
  /** The environment to read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Remove the variable after reading it, so no child process inherits it. Default true. */
  consume?: boolean;
}

/** A Secret from an environment variable set for this process; undefined if it is unset or empty. */
export function secretFromEnv(name: string, kind: SecretKind, options: EnvSecretOptions = {}): Secret | undefined {
  const env = options.env ?? process.env;
  const value = env[name];
  if (options.consume ?? true) delete env[name];
  if (value === undefined || value === "") return undefined;
  return Secret.of(value, kind);
}
