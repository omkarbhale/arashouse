// Ticket 41's host proof (docs/import.md): `get --import` onto a real lease of each flavor, with import-export-libs-js.
// Run natively on Windows or from WSL, non-elevated, by test/host/e2e-import.test.ts (ARASHOUSE_TEST_IMPORT=1); every step is a line in
// `<out>/import-<flavor>.log` and `.json`. For each flavor it:
//   1. leases a slot with `get --import` of libs-js's own `s1-base` fixture for the flavor's engine (`LIBSJS-SCRATCH-BASE`),
//      then exports that package through `run --lease` and compares the export with what was imported, item by item;
//   2. leases one with `get --import <good> --import <bad>`: the first lands a `LIBSJS-SCRATCH-I41-*` Variable, the second
//      fails, so the get exits 9 and returns the lease; once the slot is reset it leases that slot again and checks the
//      Variable and its package are gone;
//   3. greps the state folder (state, events, logs, lease files) and everything the CLI printed for each lease password.
// Every password is a Secret from the moment it is read, so `redact` replaces it in each recorded line.

import { poolHome } from "./local.js";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { getFlavor, type FlavorKey } from "../../src/core/flavors.js";
import { redact } from "../../src/core/redact.js";
import { Secret } from "../../src/core/secret.js";
import { repoRoot } from "../helpers.js";
import { ArasClient, isNoItems, newItemId } from "./aras-client.js";

const CLI = join(repoRoot, "dist/cli/index.js");

export interface ImportProofOptions {
  readonly flavor: FlavorKey;
  /** Where the record, the packages and the exports go (outside the worktree). */
  readonly out: string;
  /** libs-js's built CLI, `dist/cli.js` of a checkout; its `fixtures/` gives the scratch packages. */
  readonly arasPkg: string;
}

export interface StepRecord {
  readonly step: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every file under `dir`, relative and with `/`, upper-cased (Windows names are case-insensitive). */
function filesUnder(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.set(relative(dir, full).split("\\").join("/").toUpperCase(), full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

/** The id of the first `<Item>` of an item file. */
function itemId(file: string): string | undefined {
  return /<Item\b[^>]*\bid="([0-9A-Fa-f]{32})"/.exec(readFileSync(file, "utf8"))?.[1]?.toUpperCase();
}

export async function runImportProof(options: ImportProofOptions): Promise<StepRecord[]> {
  const { flavor, out, arasPkg } = options;
  const engine = getFlavor(flavor).libsJsEngine;
  const home = poolHome();
  const libsjs = dirname(dirname(arasPkg));
  const tag = newItemId().slice(0, 8);
  const records: StepRecord[] = [];
  const passwords: Secret[] = [];
  const outputs: string[] = [];
  const held = new Set<string>();
  const dir = join(out, `import-${flavor}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const logFile = join(out, `import-${flavor}.log`);
  writeFileSync(logFile, `ticket 41 import proof, ${flavor} (engine ${engine}), tag ${tag}, started ${new Date().toISOString()}\n`);

  const record = (step: string, ok: boolean, ms: number, detail: string) => {
    const line = redact(detail);
    records.push({ step, ok, ms, detail: line });
    const text = `${ok ? "ok  " : "FAIL"} ${step} (${(ms / 1000).toFixed(1)} s): ${line}`;
    appendFileSync(logFile, `${text}\n`);
    console.log(text);
  };
  class ProofStopped extends Error {}
  const must = (step: string, ok: boolean, detail: string, ms = 0) => {
    record(step, ok, ms, detail);
    if (!ok) throw new ProofStopped(`${step}: ${redact(detail)}`);
  };

  const cli = (args: string[], timeoutMs = 30 * 60_000): Promise<CliRun> =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ARASHOUSE_APKG: arasPkg }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (args[0] === "return" && code === 0 && args[1]) held.delete(args[1]);
        // `get --json` prints the password once on stdout; everything else is checked for it at the end.
        outputs.push(stderr);
        if (!(args[0] === "get" && args.includes("--json"))) outputs.push(stdout);
        resolve({ code, stdout, stderr, ms: Date.now() - started });
      });
    });
  const oneLine = (run: CliRun) => redact(`${run.stdout} ${run.stderr}`.replace(/\s+/g, " ").trim()).slice(0, 600);

  interface Grant {
    readonly slot: string;
    readonly url: string;
    readonly database: string;
    readonly lease_id: string;
    readonly engine: string;
    readonly password: Secret;
    readonly imports?: readonly { manifest: string; exit_code: number; log: string }[];
  }
  const get = async (holder: string, extra: string[]): Promise<{ run: CliRun; grant?: Grant }> => {
    let run = await cli(["get", flavor, "--holder", holder, "--json", "--wait", "900", ...extra]);
    // A busy laptop's WSL interop can time out reaching the broker (exit 6, "UtilAcceptVsock"); before any import started
    // no lease was handed out, so the get is tried again, twice at most.
    for (let retry = 1; retry <= 2 && run.code === 6 && !run.stderr.includes("arashouse: import 1 of"); retry++) {
      record(`get ${flavor} retried after exit 6`, true, run.ms, oneLine(run).slice(0, 200));
      await sleep(30_000);
      run = await cli(["get", flavor, "--holder", holder, "--json", "--wait", "900", ...extra]);
    }
    if (run.stdout.trim() === "") return { run };
    const json = JSON.parse(run.stdout) as Omit<Grant, "password"> & { password: string };
    const password = Secret.of(json.password, "lease-password");
    passwords.push(password);
    held.add(json.lease_id);
    return { run, grant: { ...json, password } };
  };
  const statusOf = async (slot: string): Promise<string | undefined> => {
    const run = await cli(["status", "--json"]);
    return (JSON.parse(run.stdout) as { slots: { slot: string; status: string }[] }).slots.find((s) => s.slot === slot)?.status;
  };

  try {
    // ---- 1. get --import of libs-js's s1-base, then an export of the package matches ---------------------------------
    const fixture = join(libsjs, "fixtures", engine, "import", "s1-base", "step-1", "input");
    must("1.libs-js fixture s1-base for the engine", existsSync(join(fixture, "imports.mf")), fixture);
    const input = join(dir, "s1-base");
    cpSync(fixture, input, { recursive: true });
    let t = Date.now();
    const a = await get(`import-41-${flavor}-a`, ["--import", input]);
    must(
      "1.get --import <s1-base folder>",
      a.run.code === 0 && a.grant?.imports?.[0]?.exit_code === 0,
      `exit ${a.run.code}; ${a.grant ? `${a.grant.slot}, engine ${a.grant.engine}, import exit ${a.grant.imports?.[0]?.exit_code}, log ${a.grant.imports?.[0]?.log}` : oneLine(a.run)}`,
      Date.now() - t,
    );
    const A = a.grant!;
    must("1.the engine is the flavor's", A.engine === engine && a.run.stderr.includes(`engine ${engine})`), `get reports engine ${A.engine}; stderr names engine ${engine}`);
    const importLog = A.imports![0]!.log;
    must("1.the libs-js log is under the state folder's logs/", importLog === join(home, "logs", `${A.lease_id}-import-1.log`) && existsSync(importLog), `${importLog}, ${existsSync(importLog) ? statSync(importLog).size : 0} bytes`);

    const exportDir = join(dir, "export");
    t = Date.now();
    const exp = await cli(["run", "--lease", A.lease_id, "--", process.execPath, arasPkg, "export", "--engine", engine, "--log", join(dir, "export.log"), exportDir, "--package", "LIBSJS-SCRATCH-BASE"]);
    must("1.aras-pkg export --package LIBSJS-SCRATCH-BASE through run --lease", exp.code === 0, `exit ${exp.code}: ${oneLine(exp).slice(0, 300)}`, Date.now() - t);
    const imported = filesUnder(join(input, "LIBSJS-SCRATCH-BASE"));
    const exported = filesUnder(join(exportDir, "LIBSJS-SCRATCH-BASE"));
    const missing = [...imported.keys()].filter((k) => !exported.has(k));
    const extra = [...exported.keys()].filter((k) => !imported.has(k));
    const idDiffs = [...imported.keys()].filter((k) => exported.has(k) && itemId(imported.get(k)!) !== itemId(exported.get(k)!));
    must(
      "1.the export holds every imported item, with its id",
      imported.size > 0 && missing.length === 0 && extra.length === 0 && idDiffs.length === 0,
      `${imported.size} item files imported, ${exported.size} exported; missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}; ids differ ${idDiffs.join(", ") || "none"}`,
    );
    t = Date.now();
    const ret = await cli(["return", A.lease_id]);
    must("1.return", ret.code === 0, `exit ${ret.code}: ${oneLine(ret)}`, Date.now() - t);

    // ---- 2. a failed import is atomic, and the slot is reset -----------------------------------------------------
    // A Variable's name holds 32 characters: this one is 27.
    const goodName = `LIBSJS-SCRATCH-I41-${tag}`;
    const varName = goodName;
    const good = join(dir, "good");
    mkdirSync(join(good, goodName, "Import", "Variable"), { recursive: true });
    writeFileSync(join(good, "imports.mf"), `<imports>\n  <package name="${goodName}" path="${goodName}\\Import" />\n</imports>\n`);
    writeFileSync(join(good, goodName, "Import", "Variable", `${varName}.xml`), `<AML>\n <Item type="Variable" id="${newItemId()}" action="add">\n  <default_value>${tag}</default_value>\n  <name>${varName}</name>\n </Item>\n</AML>\n`);
    // A package that names a folder that is not there: the engine cannot read it and fails the run (marking the package's
    // DatabaseUpgrade row failed), after the good one landed.
    const bad = join(dir, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "imports.mf"), `<imports>\n  <package name="LIBSJS-SCRATCH-IMPORTBAD-${tag}" path="LIBSJS-SCRATCH-IMPORTBAD-${tag}\\Import" />\n</imports>\n`);
    t = Date.now();
    const b = await get(`import-41-${flavor}-b`, ["--import", good, "--import", bad]);
    const returned = /the lease of ([a-z0-9]+-\d{2}) was returned/.exec(b.run.stderr)?.[1];
    must(
      "2.get --import <good> --import <bad> exits 9 and returns the lease",
      b.run.code === 9 && b.grant === undefined && returned !== undefined && /import 1 of 2 .* done/.test(b.run.stderr) && /import 2 of 2 .* failed: aras-pkg exit \d+; its log: \S+-import-2\.log/.test(b.run.stderr),
      `exit ${b.run.code}; ${oneLine(b.run).slice(-400)}`,
      Date.now() - t,
    );
    const slot = returned!;
    t = Date.now();
    let status: string | undefined;
    for (;;) {
      status = await statusOf(slot);
      if (status === "free" || status === "quarantined" || Date.now() - t > 15 * 60_000) break;
      await sleep(2000);
    }
    must("2.the returned slot is reset (free again)", status === "free", `${slot} ${status}`, Date.now() - t);
    // Lease the flavor's free slots until the reset one is held; the others are given back at the end.
    let again: Grant | undefined;
    for (let i = 0; i < 4 && again === undefined; i++) {
      const g = await get(`import-41-${flavor}-c${i}`, []);
      must(`2.get ${flavor} (looking for ${slot})`, g.run.code === 0 && g.grant !== undefined, `exit ${g.run.code}; ${g.grant?.slot ?? oneLine(g.run)}`);
      if (g.grant!.slot === slot) again = g.grant;
    }
    must("2.the same slot leased again", again !== undefined, slot);
    const aras = new ArasClient(again!.url, again!.database);
    const login = await aras.login("root", again!.password);
    must("2.root logs in on the new lease", login.ok, login.ok ? "token issued" : login.detail);
    if (login.ok) {
      const v = await aras.apply(login.token, `<Item type="Variable" action="get" select="name"><name>${varName}</name></Item>`);
      record("2.the Variable the first import added is gone", isNoItems(v), 0, isNoItems(v) ? `no Variable ${varName}` : (v.fault ?? "found"));
      const p = await aras.apply(login.token, `<Item type="PackageDefinition" action="get" select="name"><name>${goodName}</name></Item>`);
      record("2.its PackageDefinition is gone", isNoItems(p), 0, isNoItems(p) ? `no PackageDefinition ${goodName}` : (p.fault ?? "found"));
    }
  } catch (err) {
    if (!(err instanceof ProofStopped)) record("unexpected error", false, 0, (err as Error).message);
  } finally {
    for (const id of [...held]) {
      const r = await cli(["return", id]);
      record("give back a lease the proof holds", r.code === 0, r.ms, `exit ${r.code}`);
    }
  }

  // ---- 3. no password on disk, in a log or in what the CLI printed --------------------------------------------------
  const places: [string, string][] = [];
  for (const name of ["state.json", "events.log"]) if (existsSync(join(home, name))) places.push([name, readFileSync(join(home, name), "utf8")]);
  for (const sub of ["logs", "leases"]) {
    if (!existsSync(join(home, sub))) continue;
    for (const name of readdirSync(join(home, sub))) places.push([`${sub}/${name}`, readFileSync(join(home, sub, name), "utf8")]);
  }
  for (const [name, path] of filesUnder(dir)) if (/\.LOG$/.test(name)) places.push([`out/${name}`, readFileSync(path, "utf8")]);
  outputs.forEach((text, i) => places.push([`cli output ${i}`, text]));
  const hits = places.filter(([, text]) => passwords.some((p) => text.includes(p.reveal()))).map(([name]) => name);
  record("3.no lease password in the state folder, the libs-js logs or the CLI's output", passwords.length > 0 && hits.length === 0, 0, `${passwords.length} passwords, ${places.length} places checked; found in ${hits.join(", ") || "none"}`);

  writeFileSync(join(out, `import-${flavor}.json`), `${JSON.stringify({ flavor, engine, tag, records }, null, 2)}\n`);
  return records;
}
