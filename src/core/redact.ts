// Redaction: nothing is logged, audited or reported before it passes through `redact`. It replaces
// the values of every Secret created in this process, and the shapes a secret takes in text
// (`lic_key="..."`, `password=...`, `Authorization: ...`, `-P <x>`) whether or not a Secret was made.

export const REDACTED = "[redacted]";

/** Shorter values would redact ordinary text; a secret this short is caught by its shape instead. */
const MIN_KNOWN_LENGTH = 4;

const known = new Set<string>();
let knownOrdered: string[] | undefined;

/**
 * Teach the redactor a secret value so it is replaced wherever it appears, as typed and in its
 * URL-encoded, JSON-escaped and base64 forms. Write-only on purpose: nothing reads the set back.
 * `Secret` calls this; nothing else should.
 */
export function registerSecretValue(value: string): void {
  if (value.length < MIN_KNOWN_LENGTH) return;
  const forms = [
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value, "utf8").toString("base64"),
  ];
  for (const form of forms) {
    if (form.length >= MIN_KNOWN_LENGTH && !known.has(form)) {
      known.add(form);
      knownOrdered = undefined;
    }
  }
}

/** Longest first, so a value that contains another is replaced whole. */
function knownValues(): string[] {
  knownOrdered ??= [...known].sort((a, b) => b.length - a.length);
  return knownOrdered;
}

// A key whose value is a secret: password, passwd, pwd, secret, token, lic_key, act_key, licence key.
const SECRET_KEY = String.raw`[\w.-]*(?:password|passwd|pwd|secret|token|lic_key|act_key|licen[sc]e[_ -]?key)[\w.-]*`;
// A value: quoted, or bare up to whitespace, ';', '&' or a quote.
const VALUE = String.raw`"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&"']+`;

const KEYED_VALUE = new RegExp(String.raw`(\b${SECRET_KEY}(?:["'])?\s*[:=]\s*)(${VALUE})`, "gi");
const AUTHORIZATION = new RegExp(
  String.raw`(\b(?:Proxy-)?Authorization(?:["'])?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)`,
  "gi",
);
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// sqlcmd's -P <password> and long flags, which this tool never uses but a copied command line might.
const SHORT_FLAG = new RegExp(String.raw`(^|\s)(-P)\s+(?:${VALUE})`, "g");
const LONG_FLAG = new RegExp(String.raw`(--(?:password|passwd|secret|token|lic[a-z]*-?key))\s+(?:${VALUE})`, "gi");

/** The placeholder, inside the quotes the value had so quoted text stays well formed. */
function mask(value: string): string {
  const q = value[0];
  return (q === '"' || q === "'") && value.length > 1 && value.endsWith(q) ? `${q}${REDACTED}${q}` : REDACTED;
}

/** `text` with every secret value and every secret-shaped assignment replaced by `[redacted]`. */
export function redact(text: string): string {
  let out = String(text);
  for (const value of knownValues()) out = out.split(value).join(REDACTED);
  out = out.replace(AUTHORIZATION, (_m, head: string, value: string) => `${head}${mask(value)}`);
  out = out.replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(KEYED_VALUE, (_m, head: string, value: string) => `${head}${mask(value)}`);
  out = out.replace(SHORT_FLAG, (_m, lead: string, flag: string) => `${lead}${flag} ${REDACTED}`);
  out = out.replace(LONG_FLAG, (_m, flag: string) => `${flag} ${REDACTED}`);
  return out;
}

/** `value` as one redacted line: strings as they are, everything else as JSON (a Secret serialises as `[redacted]`). */
export function redactValue(value: unknown): string {
  if (typeof value === "string") return redact(value);
  if (value instanceof Error) return redact(errorText(value));
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  return redact(text ?? String(value));
}

function errorText(err: Error): string {
  return err.stack ?? `${err.name}: ${err.message}`;
}

/** An error's name, message and stack with every secret removed: the only form that may be logged or printed. */
export function redactError(err: unknown): { name: string; message: string; stack?: string } {
  if (!(err instanceof Error)) return { name: "Error", message: redact(String(err)) };
  const out: { name: string; message: string; stack?: string } = { name: err.name, message: redact(err.message) };
  if (err.stack !== undefined) out.stack = redact(err.stack);
  return out;
}

/**
 * A sink whose every write passes through `redact`: the audit log and the events log are built on
 * this, so they cannot be handed a secret that gets as far as a file.
 */
export function redactingSink(write: (line: string) => void): (entry: unknown) => void {
  return (entry) => write(redactValue(entry));
}
