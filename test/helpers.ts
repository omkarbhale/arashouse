import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

/** Tracked files that exist on disk and are text (no NUL byte, under 1 MiB). */
export function trackedTextFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const path of trackedFiles()) {
    const full = join(repoRoot, path);
    if (!existsSync(full) || statSync(full).size > 1024 * 1024) continue;
    const buf = readFileSync(full);
    if (buf.includes(0)) continue;
    files.push({ path, text: buf.toString("utf8") });
  }
  return files;
}

const FORBIDDEN_EXTENSIONS = [".msi", ".bak", ".zip", ".key", ".lic"];

/** Why a tracked path must not be in git, or undefined if it is fine. */
export function forbiddenTrackedReason(path: string): string | undefined {
  const lower = path.toLowerCase();
  const ext = FORBIDDEN_EXTENSIONS.find((e) => lower.endsWith(e));
  if (ext) return `${ext} file`;
  if (path.startsWith("media/") && path !== "media/README.md") return "under media/";
  return undefined;
}

// A licence key: the lic_key or act_key assignment with a non-empty value.
const LICENCE_KEY = /\b(?:lic_key|act_key)\s*=\s*[^\s"'`]/i;
// A quoted literal assigned to a name containing PASSWORD or SECRET.
const QUOTED_SECRET = /\b[A-Za-z0-9_]*(?:PASSWORD|SECRET)[A-Za-z0-9_]*["']?\s*[:=]\s*(["'`])(?!\1|\$)[^\n]*?\1/i;
// An unquoted literal in env/shell style, at the start of a line (optionally after export or set).
const UNQUOTED_SECRET = /^[ \t]*(?:export[ \t]+|set[ \t]+)?[A-Z0-9_]*(?:PASSWORD|SECRET)[A-Z0-9_]*=[^\s$%<{("'`]/m;

/** Descriptions of every secret-shaped value found in `text`. */
export function findSecretShapes(text: string): string[] {
  const found: string[] = [];
  if (LICENCE_KEY.test(text)) found.push("licence key value");
  if (QUOTED_SECRET.test(text) || UNQUOTED_SECRET.test(text)) found.push("literal PASSWORD/SECRET assignment");
  return found;
}
