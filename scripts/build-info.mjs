// Writes dist/build.json after `tsc`: the commit this build is of, whether the checkout had changes to tracked files,
// and when it was built (src/core/build.ts reads it). Run by `npm run build`.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const head = git("rev-parse", "HEAD");
const commit = /^[0-9a-f]{40}$/.test(head) ? head : "unknown";
const dirty = commit !== "unknown" && git("status", "--porcelain", "--untracked-files=no") !== "";
const info = { commit, dirty, built_at: new Date().toISOString() };
writeFileSync(new URL("../dist/build.json", import.meta.url), `${JSON.stringify(info, null, 2)}\n`);
console.log(`dist/build.json: ${commit.slice(0, 12)}${dirty ? "-dirty" : ""}`);
