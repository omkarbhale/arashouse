// Licence keys: asked for once, only when a step needs one, then stored machine-scope on the host.
// "if one is needed, it should ask for it" (captain). One stored key serves every slot of its line.

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

