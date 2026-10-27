// `arashouse teardown`'s bundle (ticket 49): `teardown.ps1` (src/broker/teardown-script.ts) and the two
// scripts it runs, `host\setup-host.ps1` (with the broker build `setup` writes next to it; teardown
// runs only its `-Uninstall`) and `sql\setup-sql.ps1`, written to a folder on the Windows side. The
// teardown script runs a child only when its SHA-256 is the one it was generated with. docs/teardown.md.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TEARDOWN_CHILDREN, TEARDOWN_RESULT_FILE, renderTeardownScript } from "../broker/teardown-script.js";
import type { FlavorKey } from "../core/flavors.js";
import { UsageError } from "../core/lease.js";
import type { WorkerIdentity } from "../core/setup-host.js";
import { writeSetupBundle, writeSetupSqlScript } from "./setup.js";

/** The teardown script's file name in the bundle. */
export const TEARDOWN_SCRIPT_NAME = "teardown.ps1";

/** The names a teardown bundle folder holds; anything else means it is not ours, and it is left alone. */
const BUNDLE_ENTRIES = new Set([TEARDOWN_SCRIPT_NAME, "host", "sql", TEARDOWN_RESULT_FILE]);

export interface TeardownBundleOptions {
  /** Where to write the bundle (a WSL path to a folder on a Windows drive). */
  readonly outDir: string;
  readonly distDir: string;
  readonly packageJson: string;
  readonly version: string;
  readonly worker: WorkerIdentity;
  readonly flavors: readonly FlavorKey[];
  readonly root?: string;
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/**
 * Writes `teardown.ps1`, `host\` (the setup bundle) and `sql\setup-sql.ps1` to `outDir`, replacing an
 * earlier teardown bundle there. Refuses a folder that holds anything else. Returns the script's path.
 */
export async function writeTeardownBundle(options: TeardownBundleOptions): Promise<string> {
  if (existsSync(options.outDir)) {
    const foreign = (await readdir(options.outDir)).filter((name) => !BUNDLE_ENTRIES.has(name));
    if (foreign.length > 0) throw new UsageError(`${options.outDir} holds ${foreign.slice(0, 3).join(", ")}, which a teardown bundle does not; choose an empty folder with --out`);
  }
  await rm(join(options.outDir, TEARDOWN_RESULT_FILE), { force: true });
  const host = await writeSetupBundle({
    outDir: join(options.outDir, "host"),
    distDir: options.distDir,
    packageJson: options.packageJson,
    version: options.version,
    worker: options.worker,
    flavors: options.flavors,
    root: options.root,
  });
  const sql = await writeSetupSqlScript({ outDir: join(options.outDir, "sql"), version: options.version, root: options.root });
  if (join(options.outDir, ...TEARDOWN_CHILDREN.host.split("\\")) !== host.script || join(options.outDir, ...TEARDOWN_CHILDREN.sql.split("\\")) !== sql) {
    throw new Error("the teardown bundle's layout has drifted from TEARDOWN_CHILDREN");
  }
  const script = renderTeardownScript({
    root: options.root,
    version: options.version,
    setupHostSha256: sha256(await readFile(host.script)),
    setupSqlSha256: sha256(await readFile(sql)),
  });
  if (!/^[\x00-\x7f]*$/.test(script)) throw new Error("the generated script is not plain ASCII, which Windows PowerShell 5.1 would misread");
  const path = join(options.outDir, TEARDOWN_SCRIPT_NAME);
  await writeFile(path, script.replace(/\r?\n/g, "\r\n"), "ascii");
  return path;
}
