// The git baseline of a leased slot's code tree (ticket 53, docs/git-baseline.md): what the repository in the slot's
// `Innovator\` holds and ignores, and how its one commit is made. Pure: no I/O. The CLI (src/cli/git.ts) builds the
// repository with git, as the worker, and has the broker's `deployCode` put it into the slot.
//
// The captain's words: "Maybe even initial commit in the provided codetree." "Aras has many volatile things in the
// codetree, we should ignore them ideally. And references to which database to use and so on are also in the codetree.
// Make the choices properly when it comes to that." So the generated `.gitignore` leaves out three kinds of file, per
// flavor where the trees differ: the secrets and identity files (never committed, and a staged one refuses the commit),
// the files that tie the tree to one slot (its database, URL, alias or keys), and the files the server writes while it
// runs, so an untouched slot shows a clean `git status` after it has served, recycled and restarted.

import { GuardError } from "./guards.js";
import { isProtectedFile } from "./code-deploy.js";
import type { FlavorKey } from "./flavors.js";

/** The folder of the slot's tree the repository is made in. */
export const GIT_REPO_SUBPATH = "Innovator";

/** The repository's folder and its generated ignore file, at the top of `Innovator\`. */
export const GIT_DIR_NAME = ".git";
export const GIT_IGNORE_NAME = ".gitignore";

/** The baseline's branch. */
export const GIT_BRANCH = "main";

/** The commit's author and committer: the tool, never a person. */
export const GIT_IDENTITY = { name: "arashouse", email: "arashouse@localhost" } as const;

/** The repository's own settings, so git on Windows and git in WSL read one index alike and change nothing on a read. */
export const GIT_REPO_CONFIG: readonly (readonly [string, string])[] = [
  // The tree is NTFS, read through `/mnt/c` from WSL as well: no executable bit, no symbolic links, no case.
  ["core.filemode", "false"],
  ["core.symlinks", "false"],
  ["core.ignorecase", "true"],
  // The bytes as they are, CRLF and all: the commit is the tree exactly as handed over.
  ["core.autocrlf", "false"],
  // Git on Windows records no inode, device or owner; git in WSL sees them through `/mnt/c`. Comparing only the
  // size and the whole-second mtime keeps either from reading every file again (through `/mnt/c`, minutes).
  ["core.checkStat", "minimal"],
  ["core.trustctime", "false"],
  ["core.logAllRefUpdates", "false"],
  ["gc.auto", "0"],
];

/** Why a rule is in the ignore file. */
export type IgnoreReason = "secret" | "environment" | "volatile";

export interface IgnoreRule {
  /** A gitignore pattern, relative to `Innovator\` (a leading `/` anchors it there). */
  readonly pattern: string;
  readonly reason: IgnoreReason;
  /** One line on why, written above the rule in the file. */
  readonly note: string;
}

/** The secrets and identity files, wherever they are (ticket 40's protected list): never committed. */
const SECRET_NAMES: readonly IgnoreRule[] = [
  { pattern: "InnovatorServerConfig.xml", reason: "secret", note: "the licence and the SQL logins (the slot's own, above Innovator\\, rendered by the reset)" },
  { pattern: "*.pfx", reason: "secret", note: "certificates with their private keys (the OAuth client's)" },
  { pattern: "*.cer", reason: "secret", note: "certificates (the OAuth server's signing certificate, rendered by the reset)" },
  { pattern: "key-*.xml", reason: "secret", note: "ASP.NET Core data-protection keys, written by the 14.x client and server" },
  { pattern: "vault.config", reason: "secret", note: "the vault server's config" },
];

/** The certificates' folders, whole: the reset renders the slot's own into them. */
const CERTIFICATES: readonly IgnoreRule[] = [
  { pattern: "/Server/App_Data/Certificates/", reason: "secret", note: "the server's OAuth client certificate and the OAuth server's certificate" },
];

/** The configs that name a certificate and its password. */
const SERVER_OAUTH: IgnoreRule = { pattern: "/Server/OAuth.config", reason: "secret", note: "names the server's OAuth certificate and holds its password" };

/** Each holds only `<ConfigFilePath>`, the slot's own `InnovatorServerConfig.xml` (the edit list renders it). */
const CONFIG_FILE_PATHS: readonly IgnoreRule[] = [
  { pattern: "/Client/Innovator.xml", reason: "environment", note: "points the client at the slot's InnovatorServerConfig.xml (rendered per slot)" },
  { pattern: "/Server/Innovator.xml", reason: "environment", note: "points the server at the slot's InnovatorServerConfig.xml (rendered per slot)" },
];

/** The runtime folders the golden manifest leaves out and the reset empties (src/core/flavors.ts, `runtimeDirs`). */
const RUNTIME: readonly IgnoreRule[] = [
  { pattern: "/Server/temp/", reason: "volatile", note: "the server's temporary files and its daily log" },
  { pattern: "/Server/dll/", reason: "volatile", note: "server methods compiled on first use" },
  { pattern: "/Server/logs/", reason: "volatile", note: "the server's debug logs" },
];

/** What the client writes when it first serves (spike 06, and measured for this ticket: docs/git-baseline.md). */
const CLIENT_BUNDLES: readonly IgnoreRule[] = [
  { pattern: "/Client/jsBundles/data.json", reason: "volatile", note: "the bundle index the client rewrites when it first serves" },
  { pattern: "/Client/jsBundles/compile.log", reason: "volatile", note: "the bundler's log, written when the client starts" },
];

const COMMON: readonly IgnoreRule[] = [...SECRET_NAMES, ...CERTIFICATES, SERVER_OAUTH, ...CONFIG_FILE_PATHS, ...RUNTIME, ...CLIENT_BUNDLES];

/** 14.35's client is an OAuth client too: its certificates and config, like the server's. */
const CLIENT_OAUTH_35: readonly IgnoreRule[] = [
  { pattern: "/Client/App_Data/Certificates/", reason: "secret", note: "the client server's OAuth certificate and the OAuth server's certificate" },
  { pattern: "/Client/OAuth.ClientServer.config", reason: "secret", note: "names the client server's OAuth certificate and holds its password" },
];

const RULES: Readonly<Record<FlavorKey, readonly IgnoreRule[]>> = {
  "12sp9": COMMON,
  "23": COMMON,
  "35": [...COMMON, ...CLIENT_OAUTH_35],
};

/** The flavor's ignore rules, in the file's order. */
export function ignoreRules(flavor: FlavorKey): readonly IgnoreRule[] {
  return RULES[flavor];
}

/** The file's sections, in order, each with its heading. */
const SECTIONS: readonly (readonly [IgnoreReason, string])[] = [
  ["secret", "Secrets and identity files: never committed (a staged one refuses the commit)."],
  ["environment", "Files that tie the tree to this slot: its database, URL, alias or keys."],
  ["volatile", "Files the server writes while it runs, recycles or restarts."],
];

/** The `.gitignore` the baseline commits, LF line endings. */
export function renderGitignore(flavor: FlavorKey): string {
  const lines = [`# Generated by arashouse for a ${flavor} lease (docs/git-baseline.md). Patterns are relative to Innovator\\.`];
  for (const [reason, heading] of SECTIONS) {
    lines.push("", `# ${heading}`);
    for (const rule of RULES[flavor].filter((r) => r.reason === reason)) lines.push(`# ${rule.note}`, rule.pattern);
  }
  return `${lines.join("\n")}\n`;
}

/** Whether `path` (relative to `Innovator\`, `/`-separated) may never be committed: a protected file, or a secret rule's file. */
export function isNeverCommitted(flavor: FlavorKey, path: string): boolean {
  if (isProtectedFile(path)) return true;
  const lower = path.toLowerCase();
  return RULES[flavor].some((rule) => {
    if (rule.reason !== "secret" || !rule.pattern.startsWith("/")) return false;
    const anchored = rule.pattern.slice(1).toLowerCase();
    return anchored.endsWith("/") ? lower.startsWith(anchored) : lower === anchored;
  });
}

/** Refuses a commit whose index holds a file that may never be committed; names the first few. */
export function assertNothingSecretStaged(flavor: FlavorKey, staged: readonly string[]): void {
  const found = staged.filter((p) => isNeverCommitted(flavor, p));
  if (found.length > 0) {
    throw new GuardError("bad-path", "path", found[0] as string, `the git baseline would commit ${found.length} secret or identity files (${found.slice(0, 3).join(", ")}); nothing was committed`);
  }
}

/** The commit's message. */
export function baselineMessage(flavor: FlavorKey, leaseId: string): string {
  return `arashouse baseline ${flavor} ${leaseId}`;
}

/** Whether a deploy target (relative to the slot's tree) is the repository's place: `--code` may not write it when `--git` makes it. */
export function isGitTarget(target: string): boolean {
  const lower = target.toLowerCase();
  const top = `${GIT_REPO_SUBPATH.toLowerCase()}/`;
  return lower === `${top}${GIT_IGNORE_NAME}` || lower.startsWith(`${top}${GIT_DIR_NAME}/`);
}

/** A commit id as the lease record keeps it. */
export function isCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
