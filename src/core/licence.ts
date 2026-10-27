// Licence keys: asked for once, only when a step needs one, then stored machine-scope on the host.
// "if one is needed, it should ask for it" (captain). One stored key serves every slot of its line.
// A login needs the whole `<License>` element (ticket 34b), so the store keeps the four values together.

import { FLAVORS, FLAVOR_KEYS, type FlavorKey, type LicenceRequirement } from "./flavors.js";
import { Secret } from "./secret.js";
import { assertSecretName, type HiddenPrompter, type SecretStore } from "./secret-store.js";

/** Exit code for a step that needs a secret it cannot ask for (no TTY) or was not given. */
export const SECRET_REQUIRED_EXIT_CODE = 8;

/** The steps that may need a key: the baseline build (ticket 24), a login, a provision edit list (ticket 25). */
export type LicenceStep = "install" | "login" | "edit-list";

/** A step needs a licence key but none is stored and none can be asked for. Exit code 8. */
export class LicenceRequiredError extends Error {
  readonly exitCode = SECRET_REQUIRED_EXIT_CODE;

  constructor(
    readonly line: string,
    reason: "no-tty" | "empty",
  ) {
    super(
      reason === "no-tty"
        ? `an Aras licence key for line ${line} is needed and none is stored; run the command again from an interactive terminal, which asks once and remembers it`
        : `no Aras licence key for line ${line} was entered; run the command again and type it at the prompt`,
    );
    this.name = "LicenceRequiredError";
  }
}

/** The distinct licence lines the registry names, in registry order. */
export function licenceLines(): string[] {
  return [...new Set(FLAVOR_KEYS.map((key) => FLAVORS[key].licence.line))];
}

function assertLine(line: string): string {
  if (!licenceLines().includes(line)) {
    throw new Error(`unknown licence line "${line}"; the lines are ${licenceLines().join(", ")}`);
  }
  return line;
}

/** The store name for a line: `licence-<line>`, the file `<root>\secrets\licence-<line>.bin`. */
export function licenceSecretName(line: string): string {
  return assertSecretName(`licence-${assertLine(line).toLowerCase()}`);
}

/** Whether `step` needs a licence key when the flavor's requirement is `required`. An edit list that names `{{secret:licence}}` needs it unless the flavor never does. */
export function licenceNeeded(required: LicenceRequirement, step: LicenceStep): boolean {
  switch (required) {
    case "never":
      return false;
    case "to-install":
      return step === "install" || step === "edit-list";
    case "to-login":
      return step === "login" || step === "edit-list";
  }
}

export function stepNeedsLicence(flavor: FlavorKey, step: LicenceStep): boolean {
  return licenceNeeded(FLAVORS[flavor].licence.required, step);
}

/** The question asked at the hidden prompt. */
export function licencePrompt(line: string): string {
  return `Aras licence key for line ${line} (not needed if you do not use ${line}.x): `;
}

export interface LicenceDeps {
  readonly store: SecretStore;
  readonly prompter: HiddenPrompter;
}

// Asks in flight, by line: two steps that need the same key in one run share one prompt.
const asking = new WeakMap<SecretStore, Map<string, Promise<Secret>>>();

/**
 * The licence key `step` on `flavor` needs, or undefined when it needs none (nothing is asked).
 * A stored key is returned as it is. Otherwise a person is asked once and the answer is stored; with
 * no TTY, or an empty answer, this throws LicenceRequiredError (exit code 8) and never guesses.
 */
export async function ensureLicence(
  flavor: FlavorKey,
  step: LicenceStep,
  deps: LicenceDeps,
): Promise<Secret | undefined> {
  if (!stepNeedsLicence(flavor, step)) return undefined;
  const line = FLAVORS[flavor].licence.line;
  const name = licenceSecretName(line);

  const stored = await deps.store.get(name);
  if (stored) return stored;
  if (!deps.prompter.interactive) throw new LicenceRequiredError(line, "no-tty");

  let byLine = asking.get(deps.store);
  if (!byLine) asking.set(deps.store, (byLine = new Map()));
  let pending = byLine.get(line);
  if (!pending) {
    pending = (async () => {
      const answer = await deps.prompter.promptSecret(licencePrompt(line), "licence");
      if (answer.length === 0) throw new LicenceRequiredError(line, "empty");
      await deps.store.put(name, answer);
      return answer;
    })().finally(() => byLine.delete(line));
    byLine.set(line, pending);
  }
  return pending;
}

/** The attributes of `<License>` a login needs together: the key alone is refused ("License Key is invalid", ticket 24). */
export const LICENCE_ATTRIBUTES = ["lic_key", "act_key", "lic_type", "company"] as const;
export type LicenceAttribute = (typeof LICENCE_ATTRIBUTES)[number];

/** A whole `<License>` element. Every value is a licence Secret, so `redact` replaces each of them. */
export type LicenceElement = Readonly<Record<LicenceAttribute, Secret>>;

/** Longer than any licence attribute; bounds what a request or a stored blob may carry. */
const MAX_LICENCE_VALUE = 4096;

/**
 * A `<License>` element from its four attribute values, as an existing install's `InnovatorServerConfig.xml` holds
 * them. `lic_key` must be non-empty; the others may be empty. Throws naming the attribute, never a value.
 */
export function licenceElement(values: Readonly<Record<string, unknown>>): LicenceElement {
  const extra = Object.keys(values).find((k) => !(LICENCE_ATTRIBUTES as readonly string[]).includes(k));
  if (extra !== undefined) throw new Error(`a licence has no "${extra.slice(0, 32)}" attribute; it has ${LICENCE_ATTRIBUTES.join(", ")}`);
  const out: Partial<Record<LicenceAttribute, Secret>> = {};
  for (const attr of LICENCE_ATTRIBUTES) {
    const value = values[attr] ?? "";
    if (typeof value !== "string") throw new Error(`the licence's ${attr} is not a string`);
    if (value.length > MAX_LICENCE_VALUE || /[\u0000-\u001f]/.test(value)) throw new Error(`the licence's ${attr} is not a <License> attribute value`);
    out[attr] = Secret.of(value, "licence");
  }
  if (out.lic_key!.length === 0) throw new Error("the licence has no lic_key");
  return out as LicenceElement;
}

/** The stored form of `licence-<line>`: the four values as one JSON object, one DPAPI blob on the host. */
export function encodeLicence(element: LicenceElement): Secret {
  const values = Object.fromEntries(LICENCE_ATTRIBUTES.map((attr) => [attr, element[attr].reveal()]));
  return Secret.of(JSON.stringify(values), "licence");
}

/**
 * The element a stored `licence-<line>` holds. A value that is not a JSON object is a key alone, as ticket 23's hidden
 * prompt stores it: `lic_key`, with the other attributes empty. Throws, naming no value, on a stored object it cannot use.
 */
export function decodeLicence(stored: Secret): LicenceElement {
  const text = stored.reveal();
  if (!text.trimStart().startsWith("{")) return licenceElement({ lic_key: text });
  let values: unknown;
  try {
    values = JSON.parse(text);
  } catch {
    throw new Error("the stored licence is not readable");
  }
  if (typeof values !== "object" || values === null || Array.isArray(values)) throw new Error("the stored licence is not readable");
  return licenceElement(values as Record<string, unknown>);
}

/** `arashouse licence forget <line>`: remove the stored key; true if there was one. */
export async function forgetLicence(line: string, store: SecretStore): Promise<boolean> {
  return store.delete(licenceSecretName(line));
}

export interface LicenceStatus {
  readonly line: string;
  /** A boolean only: the key's value is never reported. */
  readonly present: boolean;
}

export async function licenceStatus(store: SecretStore): Promise<LicenceStatus[]> {
  return Promise.all(
    licenceLines().map(async (line) => ({ line, present: await store.has(licenceSecretName(line)) })),
  );
}

/** `doctor`'s line for one licence line: "licence line 14: present". */
export function formatLicenceStatus(status: LicenceStatus): string {
  return `licence line ${status.line}: ${status.present ? "present" : "absent"}`;
}

