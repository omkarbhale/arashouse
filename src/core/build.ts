// Which build of arashouse this is: `dist/build.json`, written by `npm run build` (scripts/build-info.mjs) with the
// commit it was built from. Several copies of arashouse share one machine's state and one broker (a checkout's build,
// the WSL launcher's, a copy vendored into aras-mr-envs), and `package.json`'s version does not move, so the build id
// is what tells them apart: `arashouse version` shows it, the broker reports its own in `hostInfo`, and `doctor` warns
// when the CLI and the broker are different builds.

import { readFileSync } from "node:fs";

export interface BuildInfo {
  /** The commit the build was made from, or `unknown` outside a git checkout. */
  readonly commit: string;
  /** Whether the checkout had changes to tracked files when it was built. */
  readonly dirty: boolean;
  readonly built_at: string;
}

const COMMIT = /^(?:[0-9a-f]{40}|unknown)$/;

/** The build file next to a built tree (`<dist>/build.json`), or null when there is none (a run from source) or it is not one. */
export function readBuildInfo(file: string | URL): BuildInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { commit, dirty, built_at } = raw as Record<string, unknown>;
  if (typeof commit !== "string" || !COMMIT.test(commit) || typeof dirty !== "boolean" || typeof built_at !== "string") return null;
  return { commit, dirty, built_at };
}

/** The short id of a build (`<12 hex>`, `-dirty` when it was built with changes), or null for none. */
export function buildId(info: BuildInfo | null): string | null {
  if (info === null) return null;
  return `${info.commit === "unknown" ? "unknown" : info.commit.slice(0, 12)}${info.dirty ? "-dirty" : ""}`;
}

/** The `dist/build.json` of the build this module is part of (`dist/core/build.js`); null from source. */
export const OWN_BUILD_FILE = new URL("../build.json", import.meta.url);

/** This build's id, or null when it runs from source. */
export function ownBuildId(): string | null {
  return buildId(readBuildInfo(OWN_BUILD_FILE));
}
