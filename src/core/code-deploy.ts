// Code-tree deployment onto a lease (ticket 40, docs/code-deploy.md): the rules both sides share. The CLI
// plans a deploy from the caller's folder or zip before it takes a lease or stages anything; the broker
// plans it again from the staged copy and refuses what the CLI would have refused. Pure: no I/O.
//
// A deploy is an overlay, never a mirror: the planned files are copied over the slot's tree and nothing
// else in it changes, except the files a `deploy.json` lists under `delete`. Where it may write:
// - every target is a relative path inside the slot's tree (`<root>\slots\<key>\<NN>`), under `Innovator\`,
//   or under `VaultServer\` and `OAuthServer\` with `allowServers`;
// - no target or source path has `..`, `.`, an empty segment, a drive, a colon (no alternate data stream),
//   a trailing dot or space, or an 8.3 short name, any of which Windows could read as another file;
// - the secrets and identity files (`InnovatorServerConfig.xml`, `*.pfx`, `*.cer`, `key-*.xml`,
//   `vault.config`, whose contents the edit list and the host's store own) need `allowConfig`.

import { createHash } from "node:crypto";
import { editList, withLicenceElement, withSigningCertificate } from "./edit-lists.js";
import { FLAVOR_KEYS } from "./flavors.js";
import { GuardError } from "./guards.js";

/** Where a source lands in the slot's tree when the caller names no subpath. */
export const DEFAULT_CODE_SUBPATH = "Innovator";

/** The top-level folders of a slot's tree a deploy may write into without `allowServers`. */
export const CODE_ROOTS: readonly string[] = ["Innovator"];

/** The top-level folders `allowServers` adds. */
export const SERVER_ROOTS: readonly string[] = ["VaultServer", "OAuthServer"];

/** The file at the top of a source that says what to deploy; never copied itself. */
export const DEPLOY_MANIFEST = "deploy.json";

/** The largest `deploy.json` read, in bytes. */
export const MAX_DEPLOY_MANIFEST_BYTES = 1024 * 1024;

/** The most paths one deploy may copy or delete. */
export const MAX_DEPLOY_FILES = 100_000;

/** The file at the top of the tree that holds the licence and the SQL logins; `allowConfig` may overwrite it there. */
const SERVER_CONFIG = "InnovatorServerConfig.xml";

/** File names the edit list or the host's store own (case-insensitive); only `allowConfig` may overwrite or delete one. */
const PROTECTED: readonly RegExp[] = [/^innovatorserverconfig\.xml$/i, /\.pfx$/i, /\.cer$/i, /^key-.*\.xml$/i, /^vault\.config$/i];

/** The folders whose contents ASP.NET compiles or shadow-copies: a deploy into them clears the alias's temporary files. */
const COMPILED_DIRS: readonly string[] = ["innovator/server/bin/", "innovator/server/dll/"];

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const SHORT_NAME = /~\d/;
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f<>"|?*:]/;
const MAX_SEGMENT = 255;
const MAX_PATH = 1024;

function refuse(subject: string, detail: string): GuardError {
  return new GuardError("bad-path", "path", subject.slice(0, 200), detail);
}

/**
 * A relative path, `/`- or `\`-separated, as one deploy may name it: returned `/`-separated. Refuses an empty or absolute
 * path, a drive or colon, `..`, `.`, an empty segment, a trailing dot or space, an 8.3 short name and a device name.
 */
export function checkRelativePath(label: string, path: unknown): string {
  if (typeof path !== "string" || path.length === 0) throw refuse(String(path), `${label} is not a relative path`);
  if (path.length > MAX_PATH) throw refuse(path, `${label} is longer than ${MAX_PATH} characters`);
  if (ILLEGAL.test(path)) throw refuse(path, `${label} has a colon, a control character or one of <>"|?*`);
  if (path.startsWith("/") || path.startsWith("\\")) throw refuse(path, `${label} must be relative, not absolute`);
  const segments = path.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw refuse(path, `${label} has an empty, "." or ".." segment`);
    if (segment.length > MAX_SEGMENT) throw refuse(path, `${label} has a segment longer than ${MAX_SEGMENT} characters`);
    if (/[. ]$/.test(segment)) throw refuse(path, `${label} has a segment ending in a dot or a space, which Windows drops`);
    if (SHORT_NAME.test(segment)) throw refuse(path, `${label} looks like an 8.3 short name ("~<digit>"), which can name another file`);
    if (RESERVED_DEVICE.test(segment)) throw refuse(path, `${label} names a Windows device`);
  }
  return segments.join("/");
}

/**
 * The tree-relative files every flavor's edit list renders (docs/edits.md), lower-case and `/`-separated: the slot's
 * identity, such as `Innovator/Server/Innovator.xml`, whose `ConfigFilePath` says which `InnovatorServerConfig.xml`
 * (and so which database and logins) the slot's server uses. A deploy that replaced one could point the slot at
 * another install's configuration (ticket 50, docs/audit.md).
 */
const RENDERED_FILES: ReadonlySet<string> = new Set(
  FLAVOR_KEYS.flatMap((flavor) => withSigningCertificate(withLicenceElement(editList(flavor))).edits.map((e) => e.file.replace(/\\/g, "/").toLowerCase())),
);

/** Whether a deploy needs `allowConfig` to write or delete the tree-relative `path`. */
export function isProtectedFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return PROTECTED.some((rule) => rule.test(name)) || RENDERED_FILES.has(path.toLowerCase());
}

/** One `--code` argument: the source (a folder or a zip, a WSL or Windows path) and where it lands in the slot's tree. */
export interface CodeSpec {
  readonly source: string;
  /** Tree-relative and `/`-separated, "" for the top of the tree; `DEFAULT_CODE_SUBPATH` when the argument names none. */
  readonly subpath: string;
}

/** A subpath as a deploy uses it: `.` (or "") is the top of the slot's tree, anything else a relative path. */
export function checkSubpath(subpath: unknown): string {
  if (subpath === "." || subpath === "") return "";
  return checkRelativePath("the subpath", subpath);
}

/**
 * `<dir|zip>[:<subpath>]`. The last colon splits them, except the colon of a Windows drive (`C:\x` or `C:/x`), so
 * `C:\work\build.zip:Innovator/Server/bin` is the zip and the subpath.
 */
export function parseCodeSpec(text: string): CodeSpec {
  if (typeof text !== "string" || text.length === 0) throw refuse(String(text), "--code needs a folder or a zip");
  const from = /^[A-Za-z]:[\\/]/.test(text) ? 2 : 0;
  const colon = text.lastIndexOf(":");
  if (colon < from) return { source: text, subpath: DEFAULT_CODE_SUBPATH };
  const source = text.slice(0, colon);
  const subpath = text.slice(colon + 1);
  if (source.length === 0) throw refuse(text, "--code needs a folder or a zip before the colon");
  if (subpath.length === 0) throw refuse(text, "--code has an empty subpath after the colon (name the top of the tree as \".\")");
  return { source, subpath: checkSubpath(subpath) };
}

/** What a `deploy.json` says: the source files to copy (all of them when absent) and the tree files to delete. */
export interface DeployManifest {
  /** Source-relative paths; when present, only these are copied. */
  readonly files?: readonly string[];
  /** Paths relative to the subpath, as the copied files are: deleted from the slot's tree. Files only. */
  readonly delete?: readonly string[];
}

/** Checks a parsed `deploy.json`: an object with `files` and `delete`, each optional, each a list of relative paths. */
export function parseDeployManifest(value: unknown): DeployManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw refuse(DEPLOY_MANIFEST, "is not a JSON object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "files" && key !== "delete") throw refuse(DEPLOY_MANIFEST, `has no "${key.slice(0, 32)}" field (only "files" and "delete")`);
  }
  const list = (key: "files" | "delete"): string[] | undefined => {
    const v = record[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw refuse(DEPLOY_MANIFEST, `"${key}" is not a list`);
    if (v.length > MAX_DEPLOY_FILES) throw refuse(DEPLOY_MANIFEST, `"${key}" lists more than ${MAX_DEPLOY_FILES} paths`);
    return v.map((p) => checkRelativePath(`${DEPLOY_MANIFEST} "${key}" entry`, p));
  };
  const files = list("files");
  const del = list("delete");
  return { ...(files ? { files } : {}), ...(del ? { delete: del } : {}) };
}

/** Parses the bytes of a `deploy.json`. */
export function readDeployManifest(bytes: Uint8Array): DeployManifest {
  if (bytes.length > MAX_DEPLOY_MANIFEST_BYTES) throw refuse(DEPLOY_MANIFEST, `is larger than ${MAX_DEPLOY_MANIFEST_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ""));
  } catch {
    throw refuse(DEPLOY_MANIFEST, "is not JSON");
  }
  return parseDeployManifest(value);
}

export interface DeployRules {
  /** Tree-relative and `/`-separated, "" for the top of the tree, as `parseCodeSpec` returns it. */
  readonly subpath: string;
  /** May write `VaultServer\` and `OAuthServer\` as well as `Innovator\`. */
  readonly allowServers?: boolean;
  /** May overwrite or delete the protected files (`isProtectedFile`). */
  readonly allowConfig?: boolean;
}

export interface DeployCopy {
  /** Source-relative, `/`-separated. */
  readonly source: string;
  /** Tree-relative, `/`-separated. */
  readonly target: string;
}

export interface DeployPlan {
  readonly copies: readonly DeployCopy[];
  /** Tree-relative files to delete, before the copies. */
  readonly deletes: readonly string[];
  /** Whether a target is under `Innovator\Server\bin` or `Innovator\Server\dll`, so ASP.NET's temporary files of the alias go. */
  readonly touchesCompiled: boolean;
  /** Whether the source had a `deploy.json`. */
  readonly manifest: boolean;
}

/** Refuses a tree-relative `target` the rules do not let a deploy write or delete. */
function checkTarget(target: string, rules: DeployRules, what: string): void {
  const top = target.split("/")[0] ?? "";
  const roots = [...CODE_ROOTS, ...(rules.allowServers ? SERVER_ROOTS : [])];
  const protectedFile = isProtectedFile(target);
  if (protectedFile && !rules.allowConfig) {
    throw refuse(target, `${what} a secrets or identity file (InnovatorServerConfig.xml, *.pfx, *.cer, key-*.xml, vault.config, or a config file the edit list renders); pass --allow-config to do it`);
  }
  const atTop = target.toLowerCase() === SERVER_CONFIG.toLowerCase();
  if (atTop && rules.allowConfig) return;
  if (!roots.some((r) => r.toLowerCase() === top.toLowerCase())) {
    const more = rules.allowServers ? "" : SERVER_ROOTS.some((r) => r.toLowerCase() === top.toLowerCase()) ? "; pass --allow-servers to write it" : "";
    throw refuse(target, `${what} a path outside ${roots.map((r) => `${r}\\`).join(", ")} of the slot's tree${more}`);
  }
  if (target.split("/").length < 2) throw refuse(target, `${what} the folder ${top} itself`);
}

/**
 * The deploy of `sources` (every file of the source, source-relative and `/`-separated, as `checkRelativePath` returns
 * them; `deploy.json` among them or not) under `rules`, with its `manifest` when the source has one. Throws a
 * `GuardError` for anything the rules refuse; nothing is partly allowed.
 */
export function planDeploy(sources: readonly string[], rules: DeployRules, manifest?: DeployManifest): DeployPlan {
  const subpath = checkSubpath(rules.subpath);
  const under = (path: string) => (subpath === "" ? path : `${subpath}/${path}`);
  const present = new Map<string, string>();
  for (const raw of sources) {
    const path = checkRelativePath("a source file", raw);
    const key = path.toLowerCase();
    if (present.has(key)) throw refuse(path, `the source has it twice, differing only in case (${present.get(key)})`);
    present.set(key, path);
  }
  present.delete(DEPLOY_MANIFEST);
  let chosen: string[];
  if (manifest?.files !== undefined) {
    chosen = manifest.files.map((f) => {
      const found = present.get(f.toLowerCase());
      if (found === undefined) throw refuse(f, `${DEPLOY_MANIFEST} lists a file the source does not have`);
      return found;
    });
  } else {
    chosen = [...present.values()];
  }
  if (chosen.length > MAX_DEPLOY_FILES) throw refuse(subpath || ".", `the deploy names more than ${MAX_DEPLOY_FILES} files`);
  const targets = new Map<string, string>();
  const copies = chosen.map((source) => {
    const target = under(source);
    checkTarget(target, rules, "the deploy would write");
    const key = target.toLowerCase();
    if (targets.has(key)) throw refuse(source, `${DEPLOY_MANIFEST} lists it twice`);
    targets.set(key, target);
    return { source, target };
  });
  const deletes = (manifest?.delete ?? []).map((path) => {
    const target = under(path);
    checkTarget(target, rules, "the deploy would delete");
    if (targets.has(target.toLowerCase())) throw refuse(path, `${DEPLOY_MANIFEST} both copies and deletes it`);
    return target;
  });
  if (new Set(deletes.map((d) => d.toLowerCase())).size !== deletes.length) throw refuse(subpath || ".", `${DEPLOY_MANIFEST} lists a delete twice`);
  const compiled = [...copies.map((c) => c.target), ...deletes].some((t) => COMPILED_DIRS.some((d) => t.toLowerCase().startsWith(d)));
  return { copies, deletes, touchesCompiled: compiled, manifest: manifest !== undefined };
}

/** One deployed file as the lease record's digest counts it: its target and the SHA-256 of its bytes (hex). */
export interface DeployedFile {
  readonly target: string;
  readonly sha256: string;
}

/**
 * The deploy's manifest hash: SHA-256 over its targets (sorted) with each file's SHA-256, and its deletes. It names what
 * was deployed without holding any of it; the lease record keeps it (`code`).
 */
export function deployDigest(files: readonly DeployedFile[], deletes: readonly string[]): string {
  const sorted = [...files].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  const text = JSON.stringify({ files: sorted.map((f) => [f.target, f.sha256]), delete: [...deletes].sort() });
  return createHash("sha256").update(text).digest("hex");
}

/** The lease record's `code` value after one more deploy: the file count and the hash, chained over the deploys in order. */
export function codeRecord(previous: { readonly files: number; readonly digest: string } | undefined, files: number, digest: string): { files: number; digest: string; text: string } {
  const total = (previous?.files ?? 0) + files;
  const chained = previous === undefined ? digest : createHash("sha256").update(`${previous.digest}\n${digest}`).digest("hex");
  return { files: total, digest: chained, text: `${total} files, manifest ${chained}` };
}

/** Reads back a `code` value `codeRecord` wrote; undefined for anything else. */
export function parseCodeRecord(value: unknown): { files: number; digest: string } | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d+) files, manifest ([0-9a-f]{64})$/.exec(value);
  return m ? { files: Number(m[1]), digest: m[2] as string } : undefined;
}
