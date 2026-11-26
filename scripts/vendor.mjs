#!/usr/bin/env node
// `npm run vendor -- <dest>`: copies the built arashouse into another repository that runs it on Windows by relative
// path (aras-mr-envs vendors it): `dist/` without its source maps, a package.json for it (`"type": "module"`, the
// version), the PowerShell scripts setup uses, the JSON schemas of the CLI's output and the media layout. No source, no
// tests, no node_modules (arashouse has no runtime dependencies) and no media (AGENTS.md rule 4). The copy keeps the
// machine's one state (`%LOCALAPPDATA%\arashouse`) and names its media through ARASHOUSE_MEDIA or config.json's
// "media" (docs/windows-native.md, "A vendored copy").
//
// usage: node scripts/vendor.mjs [--from <built arashouse>] <dest>
// A relative <dest> is from the folder npm was started in. <dest> must be empty, missing, or an earlier vendored copy,
// which is replaced whole.

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The marker a vendored copy carries, so a later run knows it may replace the folder. */
export const MARKER = "VENDORED.json";

function fail(message) {
  console.error(`vendor: ${message}`);
  process.exit(2);
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/** Every file under `dir`, relative, `/`-separated. */
function files(dir, rel = "") {
  const out = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...files(dir, path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const args = process.argv.slice(2);
let from = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromAt = args.indexOf("--from");
if (fromAt !== -1) {
  if (args[fromAt + 1] === undefined) fail("--from needs a folder");
  from = resolve(args[fromAt + 1]);
  args.splice(fromAt, 2);
}
if (args.length !== 1 || args[0].startsWith("-")) fail("usage: npm run vendor -- <dest>");
const dest = resolve(process.env.INIT_CWD ?? process.cwd(), args[0]);

for (const need of ["dist/cli/index.js", "dist/broker/index.js", "dist/build.json", "package.json"]) {
  if (!existsSync(join(from, need))) fail(`${join(from, need)} is missing: run \`npm run build\` first`);
}
if (isInside(dest, from) || isInside(from, dest)) fail(`${dest} and ${from} must not contain each other`);
if (existsSync(dest)) {
  if (!statSync(dest).isDirectory()) fail(`${dest} is not a folder`);
  const held = readdirSync(dest);
  if (held.length > 0 && !held.includes(MARKER)) fail(`${dest} holds ${held.slice(0, 3).join(", ")}, and is not an earlier vendored copy; choose an empty folder`);
}

const pkg = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
if (pkg.name !== "arashouse") fail(`${from} is not an arashouse checkout or build`);
const build = JSON.parse(readFileSync(join(from, "dist", "build.json"), "utf8"));
const buildId = `${build.commit === "unknown" ? "unknown" : String(build.commit).slice(0, 12)}${build.dirty ? "-dirty" : ""}`;

// Copied into a folder beside <dest>, then swapped in, so a failed copy never leaves half a copy behind.
const staging = `${dest}.vendor-${randomBytes(4).toString("hex")}`;
const copied = [];
const copy = (rel) => {
  mkdirSync(dirname(join(staging, rel)), { recursive: true });
  cpSync(join(from, rel), join(staging, rel));
  copied.push(rel);
};
try {
  mkdirSync(staging, { recursive: true });
  for (const rel of files(join(from, "dist"))) if (!rel.endsWith(".map")) copy(`dist/${rel}`);
  for (const rel of files(join(from, "scripts"))) if (rel.endsWith(".ps1")) copy(`scripts/${rel}`);
  if (existsSync(join(from, "docs", "schemas"))) for (const rel of files(join(from, "docs", "schemas"))) if (rel.endsWith(".json")) copy(`docs/schemas/${rel}`);
  if (existsSync(join(from, "media", "README.md"))) copy("media/README.md");
  const runtime = { name: pkg.name, version: pkg.version, private: true, description: pkg.description, type: pkg.type, engines: pkg.engines, bin: pkg.bin };
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(runtime, null, 2)}\n`);
  writeFileSync(
    join(staging, MARKER),
    `${JSON.stringify({ arashouse: pkg.version, build: buildId, commit: build.commit, built_at: build.built_at, vendored_at: new Date().toISOString() }, null, 2)}\n`,
  );
  writeFileSync(
    join(staging, "README.md"),
    [
      `# arashouse (vendored, build ${buildId})`,
      "",
      "A copy of arashouse's build, made by `npm run vendor` in its repository; do not edit it, vendor a new build instead.",
      "Run it with Node 20 or newer as `node <this folder>/dist/cli/index.js <command>`, unelevated, as the worker user",
      "that `arashouse setup` recorded. The pool's state is the machine's (`%LOCALAPPDATA%\\arashouse`), shared with every",
      "other arashouse there. Name the media with ARASHOUSE_MEDIA or \"media\" in config.json. See arashouse's",
      "docs/windows-native.md.",
      "",
    ].join("\n"),
  );
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true, maxRetries: 5 });
  renameSync(staging, dest);
} catch (err) {
  rmSync(staging, { recursive: true, force: true });
  fail(err instanceof Error ? err.message : String(err));
}
const bytes = copied.reduce((sum, rel) => sum + statSync(join(dest, rel)).size, 0);
console.log(`vendored arashouse ${pkg.version} build ${buildId} to ${dest} (${copied.length + 3} files, ${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`run it as: node ${join(dest, "dist", "cli", "index.js")} <command>`);
