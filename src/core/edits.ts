// The config edit list: a slot's code tree is a mirror of its flavor's golden, and then a few values
// in a few config files differ per slot. An edit list (one per flavor, `golden\<key>\edits.json`)
// names those values; `renderFile` applies it to a file's golden bytes and `verifyFile` checks a
// file against it. Pure: the caller reads and writes the files (tickets 25 and 30).
//
// An edit is `{ file, kind, path, value, many? }`:
// - `xml`: `path` is an XPath-style selector (`/Innovator/DB-Connection/@database`); every selected
//   attribute or text is set to `value`.
// - `json`: `path` is a JSON Pointer to a string; it is set to `value`.
// - `text`: `path` is literal text; every occurrence is replaced by `value`.
// A selector or text that matches nothing is refused, and so is one that matches more than once
// unless the edit says `many`. `value` (and a `text` edit's `path`) is a template over the slot's
// names (`{{alias}}`, `{{database}}`, ...) and, in `value` only, secret handles
// (`{{secret:licence}}`). Rendering keeps every byte it does not edit; it is idempotent; and its
// report never holds a secret's value.

import { DEFAULT_INSTALL_ROOT, buildNames, slotNames, type SlotRef } from "./names.js";
import { type FlavorKey, isFlavorKey } from "./flavors.js";
import {
  ConfigTextError,
  type ValueSpan,
  decodeText,
  encodeText,
  parseJsonPointer,
  parseXmlSelector,
  selectJson,
  selectXml,
} from "./config-text.js";
import { REDACTED, redactValue } from "./redact.js";
import { Secret, type SecretKind } from "./secret.js";

export const EDIT_LIST_SCHEMA = 1;

export const EDIT_KINDS = ["xml", "json", "text"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/**
 * The names a template can use. `build.*` are the names the flavor's baseline was installed under
 * (ticket 24), which its golden config files still hold.
 */
export const EDIT_VARIABLES = [
  "alias",
  "database",
  "login.dbo",
  "login.reg",
  "agentPort",
  "slotDir",
  "vaultDir",
  "serverUrl",
  "build.alias",
  "build.database",
  "build.dir",
  "build.agentPort",
] as const;
export type EditVariable = (typeof EDIT_VARIABLES)[number];
export type EditVars = Readonly<Record<EditVariable, string>>;

/** The secret handles a template can use, and the kind of Secret each must be. */
const SQL_LOGIN = "sql-login";
export const SECRET_HANDLES = {
  licence: "licence",
  // The `<License act_key>` that goes with a key; a key alone is refused ("License Key is invalid", ticket 24).
  licence_act_key: "licence",
  db_dbo_password: SQL_LOGIN,
  db_reg_password: SQL_LOGIN,
} as const satisfies Record<string, SecretKind>;
export type SecretHandle = keyof typeof SECRET_HANDLES;
export type EditSecrets = Readonly<Partial<Record<SecretHandle, Secret>>>;

export interface Edit {
  /** Relative to the tree root, `/` separated; matched case-insensitively, as Windows does. */
  readonly file: string;
  readonly kind: EditKind;
  readonly path: string;
  readonly value: string;
  /** The selector or text may match more than once; every match is edited. */
  readonly many?: boolean;
}

export interface EditList {
  readonly schema: typeof EDIT_LIST_SCHEMA;
  readonly flavor: FlavorKey;
  readonly edits: readonly Edit[];
}

export type EditErrorCode =
  | "invalid"
  | "not-found"
  | "ambiguous"
  | "secret-missing"
  | "not-idempotent"
  | "encoding"
  | "malformed"
  | "selector";

/** Messages name the file, the edit's path and counts, never a value. */
export class EditError extends Error {
  constructor(
    readonly code: EditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditError";
  }
}

// ---- the slot's variables -----------------------------------------------------------------------

/** The innovator server URL a slot's OAuth and vault servers call: `http://localhost/<alias>/Server/InnovatorServer.aspx`. */
export function innovatorServerUrl(alias: string): string {
  return `http://localhost/${alias}/Server/InnovatorServer.aspx`;
}

/** Every template variable for a slot, from its derived names (src/core/names.ts). */
export function editVars(ref: SlotRef, root: string = DEFAULT_INSTALL_ROOT): EditVars {
  const names = slotNames(ref, root);
  const build = buildNames(ref.flavor, root);
  return {
    alias: names.alias,
    database: names.database,
    "login.dbo": names.logins.dbo,
    "login.reg": names.logins.reg,
    agentPort: String(names.agentPort),
    slotDir: names.slotDir,
    vaultDir: names.vaultDir,
    serverUrl: innovatorServerUrl(names.alias),
    "build.alias": build.alias,
    "build.database": build.database,
    "build.dir": build.dir,
    "build.agentPort": String(build.agentPort),
  };
}

// ---- templates ----------------------------------------------------------------------------------

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

type Piece = { readonly literal: string } | { readonly variable: EditVariable } | { readonly secret: SecretHandle };

function isVariable(name: string): name is EditVariable {
  return (EDIT_VARIABLES as readonly string[]).includes(name);
}

function isSecretHandle(name: string): name is SecretHandle {
  return Object.prototype.hasOwnProperty.call(SECRET_HANDLES, name);
}

function parseTemplate(template: string, allowSecrets: boolean, where: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const index = m.index ?? 0;
    if (index > last) pieces.push({ literal: template.slice(last, index) });
    const name = (m[1] ?? "").trim();
    if (name.startsWith("secret:")) {
      const handle = name.slice("secret:".length);
      if (!allowSecrets) throw new EditError("invalid", `${where}: a secret may appear only in an edit's value`);
      if (!isSecretHandle(handle)) {
        throw new EditError("invalid", `${where}: unknown secret handle "${handle}"; the handles are ${Object.keys(SECRET_HANDLES).join(", ")}`);
      }
      pieces.push({ secret: handle });
    } else if (isVariable(name)) {
      pieces.push({ variable: name });
    } else {
      throw new EditError("invalid", `${where}: unknown template variable "${name}"; the variables are ${EDIT_VARIABLES.join(", ")}`);
    }
    last = index + m[0].length;
  }
  if (last < template.length) pieces.push({ literal: template.slice(last) });
  for (const piece of pieces) {
    if ("literal" in piece && (piece.literal.includes("{{") || piece.literal.includes("}}"))) {
      throw new EditError("invalid", `${where}: a stray "{{" or "}}"`);
    }
  }
  return pieces;
}

// The one place a secret's value is read: it goes straight into the rendered config text.
function secretText(secret: Secret): string {
  return secret.reveal();
}

function expand(pieces: readonly Piece[], vars: EditVars, secrets: EditSecrets, where: string): string {
  return pieces
    .map((piece) => {
      if ("literal" in piece) return piece.literal;
      if ("variable" in piece) {
        const value = vars[piece.variable];
        if (typeof value !== "string") throw new EditError("invalid", `${where}: variable "${piece.variable}" has no value`);
        return value;
      }
      const secret = secrets[piece.secret];
      if (!Secret.isSecret(secret)) {
        throw new EditError("secret-missing", `${where}: needs the secret "${piece.secret}", which was not given`);
      }
      if (secret.kind !== SECRET_HANDLES[piece.secret]) {
        throw new EditError("secret-missing", `${where}: the secret "${piece.secret}" must be a ${SECRET_HANDLES[piece.secret]} secret`);
      }
      return secretText(secret);
    })
    .join("");
}

// ---- the list -----------------------------------------------------------------------------------

function where(edit: Pick<Edit, "file" | "path">): string {
  return `${edit.file} ${edit.path}`;
}

function assertEditFile(file: unknown): asserts file is string {
  const ok =
    typeof file === "string" &&
    file !== "" &&
    !file.includes("\\") &&
    !file.includes("\0") &&
    !file.startsWith("/") &&
    !/^[A-Za-z]:/.test(file) &&
    file.split("/").every((s) => s !== "" && s !== "." && s !== "..");
  if (!ok) throw new EditError("invalid", `unsafe edit file ${JSON.stringify(file)}: a relative path with '/' and no '..'`);
}

const EDIT_KEYS = new Set(["file", "kind", "path", "value", "many"]);

function checkEdit(raw: unknown, index: number): Edit {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new EditError("invalid", `edit ${index} is not an object`);
  const e = raw as Record<string, unknown>;
  for (const key of Object.keys(e)) if (!EDIT_KEYS.has(key)) throw new EditError("invalid", `edit ${index} has an unknown field "${key}"`);
  assertEditFile(e.file);
  if (!(EDIT_KINDS as readonly unknown[]).includes(e.kind)) throw new EditError("invalid", `edit ${index}: kind must be one of ${EDIT_KINDS.join(", ")}`);
  if (typeof e.path !== "string" || e.path === "") throw new EditError("invalid", `edit ${index}: path must be a non-empty string`);
  if (typeof e.value !== "string") throw new EditError("invalid", `edit ${index}: value must be a string`);
  if (e.many !== undefined && typeof e.many !== "boolean") throw new EditError("invalid", `edit ${index}: many must be a boolean`);
  const edit: Edit = {
    file: e.file,
    kind: e.kind as EditKind,
    path: e.path,
    value: e.value,
    ...(e.many === true ? { many: true } : {}),
  };
  const at = where(edit);
  parseTemplate(edit.value, true, at);
  try {
    if (edit.kind === "xml") parseXmlSelector(edit.path);
    else if (edit.kind === "json") parseJsonPointer(edit.path);
    else parseTemplate(edit.path, false, at);
  } catch (err) {
    throw err instanceof ConfigTextError ? new EditError("invalid", `${at}: ${err.message}`) : err;
  }
  return edit;
}

/** Validate an edit list (an `edits.json` text or its parsed value). Throws EditError("invalid"). */
export function parseEditList(input: unknown): EditList {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input) as unknown;
    } catch {
      throw new EditError("invalid", "the edit list is not JSON");
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new EditError("invalid", "the edit list is not an object");
  const r = raw as Record<string, unknown>;
  if (r.schema !== EDIT_LIST_SCHEMA) throw new EditError("invalid", `the edit list's schema must be ${EDIT_LIST_SCHEMA}`);
  if (!isFlavorKey(r.flavor)) throw new EditError("invalid", "the edit list names no known flavor");
  if (!Array.isArray(r.edits) || r.edits.length === 0) throw new EditError("invalid", "the edit list has no edits");
  const edits = r.edits.map(checkEdit);
  const seen = new Set<string>();
  for (const edit of edits) {
    const key = `${edit.file.toLowerCase()}\0${edit.kind}\0${edit.path}`;
    if (seen.has(key)) throw new EditError("invalid", `${where(edit)} is edited twice`);
    seen.add(key);
  }
  return { schema: EDIT_LIST_SCHEMA, flavor: r.flavor, edits };
}

/** `edits.json`: two-space JSON with a trailing newline. */
export function serializeEditList(list: EditList): string {
  return `${JSON.stringify(parseEditList(list), null, 2)}\n`;
}

function sameFile(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

/** The files a list edits, each once, in list order. */
export function editListFiles(list: EditList): string[] {
  const files: string[] = [];
  for (const edit of list.edits) if (!files.some((f) => sameFile(f, edit.file))) files.push(edit.file);
  return files;
}

/** The secret handles a list's values use, so the caller fetches only those (a licence via `ensureLicence`). */
export function secretsNeeded(list: EditList): SecretHandle[] {
  const handles = new Set<SecretHandle>();
  for (const edit of list.edits) {
    for (const piece of parseTemplate(edit.value, true, where(edit))) if ("secret" in piece) handles.add(piece.secret);
  }
  return [...handles];
}

function editsFor(list: EditList, file: string): Edit[] {
  assertEditFile(file.replace(/\\/g, "/"));
  const edits = list.edits.filter((e) => sameFile(e.file, file));
  if (edits.length === 0) throw new EditError("invalid", `the edit list does not edit ${file}`);
  return edits;
}

// ---- applying one edit --------------------------------------------------------------------------

interface Target {
  readonly edit: Edit;
  readonly value: string;
  readonly secret: boolean;
}

function target(edit: Edit, vars: EditVars, secrets: EditSecrets): Target {
  const at = where(edit);
  const pieces = parseTemplate(edit.value, true, at);
  return { edit, value: expand(pieces, vars, secrets, at), secret: pieces.some((p) => "secret" in p) };
}

function locate(text: string, edit: Edit): ValueSpan[] {
  try {
    return edit.kind === "xml" ? selectXml(text, parseXmlSelector(edit.path)) : selectJson(text, parseJsonPointer(edit.path));
  } catch (err) {
    if (err instanceof ConfigTextError) throw new EditError(err.code, `${where(edit)}: ${err.message}`);
    throw err;
  }
}

function count(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

function cardinality(edit: Edit, matches: number): void {
  if (matches === 0) throw new EditError("not-found", `${where(edit)}: matches nothing`);
  if (matches > 1 && !edit.many) throw new EditError("ambiguous", `${where(edit)}: matches ${matches} times and is not marked many`);
}

type Applied = { readonly text: string; readonly status: EditStatus; readonly matches: number };

function apply(text: string, t: Target, vars: EditVars): Applied {
  const { edit, value } = t;
  if (edit.kind === "text") {
    const find = expand(parseTemplate(edit.path, false, where(edit)), vars, {}, where(edit));
    if (find === "") throw new EditError("invalid", `${where(edit)}: the text to find is empty`);
    if (value.includes(find)) throw new EditError("not-idempotent", `${where(edit)}: the replacement contains the text it replaces`);
    const found = count(text, find);
    if (found === 0) {
      const already = count(text, value);
      cardinality(edit, already);
      return { text, status: "already", matches: already };
    }
    cardinality(edit, found);
    return { text: text.split(find).join(value), status: "applied", matches: found };
  }
  const spans = locate(text, edit);
  cardinality(edit, spans.length);
  let out = text;
  let changed = false;
  for (const span of [...spans].reverse()) {
    if (span.value === value) continue;
    out = out.slice(0, span.start) + span.encode(value) + out.slice(span.end);
    changed = true;
  }
  return { text: out, status: changed ? "applied" : "already", matches: spans.length };
}

// ---- render and verify --------------------------------------------------------------------------

export type EditStatus = "applied" | "already";

/** One edit's line in the events log: never a secret's value. */
export interface EditOutcome {
  readonly file: string;
  readonly kind: EditKind;
  readonly path: string;
  readonly status: EditStatus;
  readonly matches: number;
  /** The value set, or `[redacted]` when it holds a secret. */
  readonly value: string;
}

export interface RenderResult {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
  readonly outcomes: readonly EditOutcome[];
}

function decode(file: string, bytes: Uint8Array): ReturnType<typeof decodeText> {
  try {
    return decodeText(bytes);
  } catch (err) {
    if (err instanceof ConfigTextError) throw new EditError(err.code, `${file}: ${err.message}`);
    throw err;
  }
}

function shown(t: Target): string {
  return t.secret ? REDACTED : redactValue(t.value);
}

/**
 * Apply the list's edits for `file` to its bytes (normally golden's). Every byte the edits do not
 * set is kept, including the encoding, BOM and line endings; rendering rendered bytes gives the same
 * bytes, with every edit `already`. Throws EditError on a selector that matches nothing or (without
 * `many`) more than once, on a missing secret, and on a file it cannot parse.
 */
export function renderFile(file: string, bytes: Uint8Array, list: EditList, vars: EditVars, secrets: EditSecrets): RenderResult {
  const edits = editsFor(list, file);
  const { text, encoding } = decode(file, bytes);
  let current = text;
  const outcomes: EditOutcome[] = [];
  for (const edit of edits) {
    const t = target(edit, vars, secrets);
    const result = apply(current, t, vars);
    current = result.text;
    outcomes.push({ file: edit.file, kind: edit.kind, path: edit.path, status: result.status, matches: result.matches, value: shown(t) });
  }
  const changed = current !== text;
  return { bytes: changed ? encodeText(current, encoding) : bytes, changed, outcomes };
}

export type VerifyStatus = "ok" | "differs" | "error";

export interface VerifyOutcome {
  readonly file: string;
  readonly kind: EditKind;
  readonly path: string;
  readonly status: VerifyStatus;
  /** Why it is not `ok`, without values. */
  readonly detail?: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly outcomes: readonly VerifyOutcome[];
}

/**
 * Check a rendered file: every edit for it must already hold (what a render would report as
 * `already`). Never throws for the file's content; a problem is an outcome. Ticket 32 runs this
 * after a reset.
 */
export function verifyFile(file: string, bytes: Uint8Array, list: EditList, vars: EditVars, secrets: EditSecrets): VerifyResult {
  const edits = editsFor(list, file);
  let text: string;
  try {
    text = decode(file, bytes).text;
  } catch (err) {
    const detail = redactValue(err instanceof Error ? err.message : String(err));
    return { ok: false, outcomes: edits.map((e) => ({ file: e.file, kind: e.kind, path: e.path, status: "error" as const, detail })) };
  }
  const outcomes = edits.map((edit): VerifyOutcome => {
    const base = { file: edit.file, kind: edit.kind, path: edit.path };
    try {
      const result = apply(text, target(edit, vars, secrets), vars);
      return result.status === "already" ? { ...base, status: "ok" } : { ...base, status: "differs", detail: `${result.matches} value(s) differ` };
    } catch (err) {
      if (!(err instanceof EditError)) throw err;
      return { ...base, status: err.code === "not-found" || err.code === "ambiguous" ? "differs" : "error", detail: redactValue(err.message) };
    }
  });
  return { ok: outcomes.every((o) => o.status === "ok"), outcomes };
}

/** The events-log lines for a render, through `redact`: `applied InnovatorServerConfig.xml /Innovator/DB-Connection/@database (1) = arashouse_12sp9_01`. */
export function formatEditOutcomes(outcomes: readonly EditOutcome[]): string[] {
  return outcomes.map((o) => redactValue(`${o.status} ${o.file} ${o.path} (${o.matches}) = ${o.value}`));
}
