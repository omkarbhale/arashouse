// Ticket 35: the whole lease cycle on the host for one flavor, with a deliberately dirtied slot. It proves the
// captain's promise end to end: "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it
// has cleaned up." A returned slot is wiped, and the next lease is clean. Run from WSL, non-elevated, by
// test/host/e2e-12sp9.test.ts, e2e-23.test.ts and e2e-35.test.ts (ARASHOUSE_TEST_E2E=1); every step is recorded in
// `<out>/cycle-<n>.json` and `.log` for docs/e2e-12sp9.md, docs/e2e-23.md (ticket 36, which adds the 14.x OAuth
// server's runtime state: its SQLite file, where a lease's refresh token lives, and its data-protection keys) and
// docs/e2e-35.md (ticket 52, which adds 14.35's import options).
//
// It drives the built CLI (`dist/`) as a worker would, and dirties the lease only as a leaseholder could: logged in as
// root with the lease's password it imports a LIBSJS-SCRATCH package with libs-js `aras-pkg`, adds items through the
// API, uploads a file to the vault, and runs a server Method of its own that writes into the slot's tree as the slot's
// pool identity (which a provision grants modify on the slot folder). Nothing here writes to the host otherwise; the
// slot folder is only read (the worker's grant), and the golden and the vault through the broker and the slot's server.
//
// Secrets: every password is a Secret from the moment it is read, so `redact` replaces it in each recorded line. The
// golden backup's root password is used only inside test/host/login-check.ps1, from its DPAPI file.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "../../src/core/redact.js";
import { Secret } from "../../src/core/secret.js";
import { type FlavorKey, getFlavor } from "../../src/core/flavors.js";
import { BrokerHost, interopTransport } from "../../src/host/index.js";
import { repoRoot } from "../helpers.js";
import { ArasClient, type Login, isNoItems, newItemId, xmlText } from "./aras-client.js";

const CLI = join(repoRoot, "dist/cli/index.js");
const ROOT_WSL = "/mnt/c/aras_installations";
const ROOT_WIN = "C:\\aras_installations";
/** How long the leaseholder's lock in step 8 is held: enough for a reset to fail twice (about 30 s), and then it ends. */
const LOCK_SECONDS = 150;
/**
 * A `get` that should lease at once waits out a dip in the host's free RAM under `min_free_ram_mb` (docs/governor.md),
 * which the laptop's other work causes now and then (ticket 36); a slot the cycle expects is free is leased at once. Other
 * lanes' leases kept it under for more than 300 s once (ticket 52), so it waits up to 15 minutes, as step 7's own `get` does.
 */
const RAM_WAIT = ["--wait", "900"];

export interface CycleOptions {
  /** The cycle's number (1, 2, ...): its record files and the path the recovery takes. */
  readonly cycle: number;
  readonly flavor: FlavorKey;
  /** The libs-js engine for the flavor (`12.0` for 12sp9). */
  readonly engine: string;
  /** Where the record, the export and the scratch package go (outside the worktree). */
  readonly out: string;
  /** libs-js's built CLI, `dist/cli.js`. */
  readonly arasPkg: string;
  /** The golden backup's root password file (ConvertFrom-SecureString output); without it the OOTB checks are skipped. */
  readonly ootbFile?: string;
  /**
   * 14.x: also dirty and check the OAuth server's runtime state (design report 5.2, `OAuthServer\App_Data`): a refresh
   * token in its SQLite file and extra `key-*.xml` and `*.sqlite` files, which the reset must take away, and the old
   * lease's access and refresh tokens, which the next lease must refuse.
   */
  readonly oauthState?: boolean;
  /**
   * Who holds step 8's lock. `pool` (12sp9): a process the leaseholder's Method starts as the slot's pool identity, which
   * outlives the pool stop. On 14.x that process does not outlive the quiesce (the reset simply succeeded, ticket 36), so
   * `worker`: the Method only writes the file, and the worker's own Windows process holds it open with no sharing, as a
   * leaseholder's editor or tool could.
   */
  readonly lockHolder?: "pool" | "worker";
  /**
   * 14.35 only (ticket 52, the libs-js README): a second scratch package imported with `--batch` and `--collect-errors`,
   * with `--languages` when golden has a language besides `en`. Its items must be gone on the next lease like the rest.
   */
  readonly importOptions1435?: boolean;
}

interface StepRecord {
  readonly step: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

interface Grant {
  readonly slot: string;
  readonly url: string;
  readonly database: string;
  readonly user: string;
  readonly lease_id: string;
  readonly password: Secret;
}

interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

interface StatusRow {
  readonly slot: string;
  readonly status: string;
  readonly holder: string | null;
  readonly last_reset_ms: number | null;
  readonly quarantine_reason: string | null;
}

export class CycleFailed extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The slot's number as two digits, from `12sp9-01`. */
const slotNumber = (slot: string) => slot.slice(slot.lastIndexOf("-") + 1);

/** The server Method the leaseholder runs: `dirt` writes into the slot's tree, `probe` counts the vault and temp files. */
export function methodCode(): string {
  return `Innovator inn = this.getInnovator();
string tag = this.getProperty("tag", "");
string mode = this.getProperty("mode", "");
if (!System.Text.RegularExpressions.Regex.IsMatch(tag, "^[a-z0-9]{8}$")) return inn.newError("arashouse e2e: bad tag");
string server = System.IO.Path.GetFullPath(System.AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\\\');
// 12.0's server is an ASP.NET application rooted in Innovator\\Server; 14.x's is Aras.Server.exe, run from its bin folder.
if (System.IO.Path.GetFileName(server).Equals("bin", System.StringComparison.OrdinalIgnoreCase)) server = System.IO.Path.GetDirectoryName(server);
string innovatorDir = System.IO.Path.GetDirectoryName(server);
string slotDir = System.IO.Path.GetDirectoryName(innovatorDir);
if (!slotDir.StartsWith(@"${ROOT_WIN}\\slots\\", System.StringComparison.OrdinalIgnoreCase)) return inn.newError("arashouse e2e: not a slot folder: " + slotDir);
if (mode == "dirt") {
  System.IO.File.WriteAllText(System.IO.Path.Combine(innovatorDir, @"Client\\arashouse-e2e-" + tag + ".txt"), "arashouse e2e dirt " + tag);
  System.IO.File.WriteAllText(System.IO.Path.Combine(server, @"temp\\arashouse-e2e-" + tag + ".txt"), "arashouse e2e dirt " + tag);
  string cfg = System.IO.Path.Combine(slotDir, "InnovatorServerConfig.xml");
  System.Xml.XmlDocument doc = new System.Xml.XmlDocument();
  doc.PreserveWhitespace = true;
  doc.Load(cfg);
  System.Xml.XmlElement op = doc.CreateElement("operating_parameter");
  op.SetAttribute("key", "arashouse_e2e");
  op.SetAttribute("value", tag);
  doc.DocumentElement.AppendChild(op);
  doc.Save(cfg);
  string[] dlls = System.IO.Directory.GetFiles(System.IO.Path.Combine(server, "bin"), "*.dll");
  System.Array.Sort(dlls, System.StringComparer.OrdinalIgnoreCase);
  string dll = dlls[dlls.Length - 1];
  byte[] pad = System.Text.Encoding.ASCII.GetBytes("arashouse-e2e-" + tag);
  using (System.IO.FileStream fs = new System.IO.FileStream(dll, System.IO.FileMode.Append, System.IO.FileAccess.Write)) { fs.Write(pad, 0, pad.Length); }
  return inn.newResult("dll=" + System.IO.Path.GetFileName(dll));
}
if (mode == "lockfile") {
  System.IO.File.WriteAllText(System.IO.Path.Combine(innovatorDir, @"Client\\arashouse-e2e-lock-" + tag + ".txt"), "arashouse e2e lock " + tag);
  return inn.newResult("lockfile=1");
}
if (mode == "lock") {
  // A process of the leaseholder's that outlives the lease and holds an extra file open with no sharing. Its command line
  // does not name the slot folder (the path is in its environment), so the reset cannot tell it is the slot's.
  int seconds = int.Parse(this.getProperty("seconds", "0"));
  if (seconds < 30 || seconds > 900) return inn.newError("arashouse e2e: bad seconds");
  string lockFile = System.IO.Path.Combine(innovatorDir, @"Client\\arashouse-e2e-lock-" + tag + ".txt");
  System.IO.File.WriteAllText(lockFile, "arashouse e2e lock " + tag);
  System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo(
    System.Environment.ExpandEnvironmentVariables(@"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    "-NoProfile -NonInteractive -Command \\"$f = [IO.File]::Open($env:ARASHOUSE_E2E_LOCK, 'Open', 'ReadWrite', 'None'); Start-Sleep -Seconds " + seconds + "; $f.Close()\\"");
  psi.UseShellExecute = false;
  psi.CreateNoWindow = true;
  psi.EnvironmentVariables["ARASHOUSE_E2E_LOCK"] = lockFile;
  System.Diagnostics.Process p = System.Diagnostics.Process.Start(psi);
  return inn.newResult("pid=" + p.Id);
}
if (mode == "oauth") {
  // Files the OAuth server's runtime rules match (key-*.xml, *.sqlite*), as a leaseholder's code could leave them. The key
  // ring ignores an element that is not a key, so the server runs on unharmed.
  string appData = System.IO.Path.Combine(slotDir, @"OAuthServer\\App_Data");
  System.IO.File.WriteAllText(System.IO.Path.Combine(appData, "key-arashouse-e2e-" + tag + ".xml"), "<?xml version=\\"1.0\\" encoding=\\"utf-8\\"?><arashouseE2e tag=\\"" + tag + "\\" />");
  System.IO.File.WriteAllText(System.IO.Path.Combine(appData, "arashouse-e2e-" + tag + ".sqlite"), "arashouse e2e dirt " + tag);
  return inn.newResult("oauth=2");
}
if (mode == "probe") {
  string vault = this.getProperty("vault", "");
  if (!System.Text.RegularExpressions.Regex.IsMatch(vault, @"^C:\\\\aras_installations\\\\vaults\\\\[a-z0-9]+-[0-9]{2}$")) return inn.newError("arashouse e2e: bad vault");
  int files = System.IO.Directory.Exists(vault) ? System.IO.Directory.GetFiles(vault, "*", System.IO.SearchOption.AllDirectories).Length : -1;
  return inn.newResult("vault=" + files);
}
return inn.newError("arashouse e2e: bad mode");`;
}

export async function runCycle(options: CycleOptions): Promise<StepRecord[]> {
  const { cycle, flavor, out } = options;
  const home = process.env.ARASHOUSE_HOME || join(homedir(), ".arashouse");
  const tag = randomBytes(4).toString("hex");
  const TAG = tag.toUpperCase();
  const records: StepRecord[] = [];
  const seenPasswords: Secret[] = [];
  const outputs: string[] = [];
  mkdirSync(out, { recursive: true });
  const logFile = join(out, `cycle-${cycle}.log`);
  writeFileSync(logFile, `cycle ${cycle}, ${flavor}, tag ${tag}, started ${new Date().toISOString()}\n`);
  let failures = 0;

  const record = (step: string, ok: boolean, ms: number, detail: string) => {
    const line = redact(detail);
    records.push({ step, ok, ms, detail: line });
    if (!ok) failures++;
    const text = `${ok ? "ok  " : "FAIL"} ${step} (${(ms / 1000).toFixed(1)} s): ${line}`;
    appendFileSync(logFile, `${text}\n`);
    console.log(text);
  };
  /** A check: recorded, and counted as a failure when `ok` is false. */
  const check = (step: string, ok: boolean, detail: string, ms = 0) => record(step, ok, ms, detail);
  /** A step the rest depends on: recorded, and the cycle ends when it fails. */
  const must = (step: string, ok: boolean, detail: string, ms = 0) => {
    record(step, ok, ms, detail);
    if (!ok) throw new CycleFailed(`cycle ${cycle}: ${step}: ${redact(detail)}`);
  };

  const cli = (args: string[], timeoutMs = 20 * 60_000): Promise<CliRun> =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [CLI, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        const run = { code, stdout, stderr, ms: Date.now() - started };
        if (args[0] === "return" && code === 0 && args[1]) held.delete(args[1]);
        // `get --json` prints the password once on stdout; everything else is checked for it at the end.
        if (!(args[0] === "get" && args.includes("--json"))) outputs.push(stdout, stderr);
        else outputs.push(stderr);
        resolve(run);
      });
    });
  const oneLine = (run: CliRun) => redact(`${run.stdout} ${run.stderr}`.replace(/\s+/g, " ").trim()).slice(0, 400);

  /** The leases this cycle holds: given back if it stops early, so a failed cycle leaves no lease behind. */
  const held = new Set<string>();
  const get = async (holder: string, extra: string[] = []): Promise<{ run: CliRun; grant?: Grant }> => {
    const run = await cli(["get", flavor, "--holder", holder, "--json", ...extra]);
    if (run.code !== 0) return { run };
    const json = JSON.parse(run.stdout) as Omit<Grant, "password"> & { password: string };
    const password = Secret.of(json.password, "lease-password");
    seenPasswords.push(password);
    held.add(json.lease_id);
    return { run, grant: { slot: json.slot, url: json.url, database: json.database, user: json.user, lease_id: json.lease_id, password } };
  };
  const status = async (): Promise<StatusRow[]> => {
    const run = await cli(["status", "--json"]);
    if (run.code !== 0) throw new CycleFailed(`status --json exited ${run.code}: ${oneLine(run)}`);
    return (JSON.parse(run.stdout) as { slots: StatusRow[] }).slots;
  };
  const rowOf = async (slot: string) => (await status()).find((r) => r.slot === slot);
  /** Polls `status` until the slot is one of `want`; fails at `fail` statuses or the deadline. */
  const waitFor = async (slot: string, want: string[], timeoutMs: number, fail: string[] = []): Promise<{ row?: StatusRow; ms: number }> => {
    const started = Date.now();
    for (;;) {
      const row = await rowOf(slot);
      if (row && (want.includes(row.status) || fail.includes(row.status))) return { row, ms: Date.now() - started };
      if (Date.now() - started > timeoutMs) return { row, ms: Date.now() - started };
      await sleep(2000);
    }
  };
  const lastResetLine = (slot: string): string => {
    const lines = readFileSync(join(home, "events.log"), "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = JSON.parse(lines[i]!) as { slot?: string; to?: string; reason?: string };
      if (e.slot === slot && e.to === "free") return e.reason ?? "";
    }
    return "";
  };
  const resetRecord = (slot: string): { pid: number } | undefined => {
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { slots: { id: string; status: string; reset?: { pid: number } }[] };
    const s = state.slots.find((x) => x.id === slot);
    return s?.status === "resetting" ? s.reset : undefined;
  };

  const slotDir = (slot: string) => join(ROOT_WSL, "slots", flavor, slotNumber(slot));
  const binHashes = (slot: string): Map<string, string> => {
    const bin = join(slotDir(slot), "Innovator/Server/bin");
    return new Map(readdirSync(bin).filter((f) => /\.dll$/i.test(f)).map((f) => [f, sha256(readFileSync(join(bin, f)))]));
  };
  const configHash = (slot: string) => sha256(readFileSync(join(slotDir(slot), "InnovatorServerConfig.xml")));
  /** The OAuth signing certificate's public part as each application holds it (ticket 54): SHA-256 by tree path. */
  const signingCers = (slot: string): Map<string, string> => {
    const dir = slotDir(slot);
    const apps = readdirSync(dir).flatMap((a) => (a === "Innovator" ? ["Innovator/Client", "Innovator/Server"] : [a]));
    return new Map(
      apps.map((a) => `${a}/App_Data/Certificates/OAuthServer.cer`).filter((f) => existsSync(join(dir, f))).map((f) => [f, sha256(readFileSync(join(dir, f)))]),
    );
  };
  /** OAuth's runtime files (flavors.ts RUNTIME_DIRS): each `key-*.xml` by SHA-256, each `*.sqlite*` by name only. */
  const oauthFiles = (slot: string): Map<string, string> => {
    const dir = join(slotDir(slot), "OAuthServer/App_Data");
    return new Map(
      readdirSync(dir)
        .filter((f) => /\.sqlite/i.test(f) || /^key-.*\.xml$/i.test(f))
        .map((f) => [f, /^key-/i.test(f) ? sha256(readFileSync(join(dir, f))) : "sqlite"]),
    );
  };
  /** The OAuth server's persisted grants (a refresh token is one), counted in a copy of its SQLite file, deleted after. */
  const persistedGrants = async (slot: string): Promise<number> => {
    // The server keeps the file in WAL mode: the copy takes the write-ahead log with it, where the latest grants are.
    const copy = join(out, `cycle-${cycle}-oauth.sqlite`);
    const source = join(slotDir(slot), "OAuthServer/App_Data/OAuthServer.sqlite");
    writeFileSync(copy, readFileSync(source));
    if (existsSync(`${source}-wal`)) writeFileSync(`${copy}-wal`, readFileSync(`${source}-wal`));
    try {
      // node:sqlite is Node 22.5 or newer, and the host runs the cycle only: CI on Node 20 must still load this module.
      const sqlite = (await import("node:sqlite" as string)) as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => { prepare(sql: string): { get(): unknown }; close(): void } };
      const db = new sqlite.DatabaseSync(copy, { readOnly: true });
      try {
        return (db.prepare(`SELECT count(*) AS n FROM "PersistedGrants"`).get() as { n: number }).n;
      } finally {
        db.close();
      }
    } finally {
      for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) rmSync(f, { force: true });
    }
  };

  /** The golden backup's password tried as root, inside login-check.ps1: true when it logs in. */
  const ootbLogsIn = async (slot: string): Promise<{ loggedIn: boolean; line: string } | undefined> => {
    if (!options.ootbFile) return undefined;
    const script = await toWindows(join(repoRoot, "test/host/login-check.ps1"));
    const r = await runPs(["-File", script, "-Flavor", flavor, "-Slot", slotNumber(slot), "-PasswordFile", options.ootbFile]);
    return { loggedIn: r.code === 0, line: redact(r.stdout.trim() || r.stderr.trim()) };
  };

  const host = new BrokerHost(interopTransport({ node: process.env.ARASHOUSE_WINDOWS_NODE || undefined }));
  const t0 = Date.now();
  const since = (t: number) => Date.now() - t;

  try {
    // ---- 9 (before): the deny-list objects the worker can read ------------------------------------------------
    const denyBefore = await denyListPrints();
    check("9.deny-list before", Object.keys(denyBefore).length > 0, `${Object.keys(denyBefore).length} objects fingerprinted (names and hashes only)`);

    // ---- 1. provision ------------------------------------------------------------------------------------------
    let t = Date.now();
    const provision = await cli(["provision", flavor, "2"]);
    must(`1.provision ${flavor} 2`, provision.code === 0, oneLine(provision), provision.ms);
    const initial = await status();
    const ours = initial.filter((r) => r.slot === `${flavor}-01` || r.slot === `${flavor}-02`);
    must("1.both slots free", ours.length === 2 && ours.every((r) => r.status === "free"), ours.map((r) => `${r.slot} ${r.status}`).join(", "));

    // ---- 2. get, log in, export --------------------------------------------------------------------------------
    t = Date.now();
    const a = await get(`e2e-${cycle}-a`, RAM_WAIT);
    must("2.get --json", a.grant !== undefined, a.grant ? `${a.grant.slot} at ${a.grant.url}, lease ${a.grant.lease_id.slice(0, 8)}` : oneLine(a.run), a.run.ms);
    const A = a.grant!;
    const aras = new ArasClient(A.url, A.database);
    const loginA = await aras.login("root", A.password);
    must("2.root logs in with the lease's password (from WSL)", loginA.ok, loginA.ok ? "token issued" : loginA.detail);
    const token = (loginA as { token: Secret }).token;
    const ootbA = await ootbLogsIn(A.slot);
    if (ootbA) check("2.root does not log in with the golden backup's password", !ootbA.loggedIn, ootbA.line);

    const itLang = await aras.apply(token, `<Item type="ItemType" action="get" select="id"><name>Language</name></Item>`);
    const langTypeId = /<Item[^>]*\bid="([0-9A-F]{32})"/.exec(itLang.body)?.[1];
    must("2.ItemType Language found", langTypeId !== undefined, langTypeId ?? itLang.fault ?? "no id");
    const exportDir = join(out, `cycle-${cycle}-export`);
    rmSync(exportDir, { recursive: true, force: true });
    t = Date.now();
    const exp = await cli(["run", "--lease", A.lease_id, "--", "node", options.arasPkg, "export", "--engine", options.engine, "--json", "--log", join(out, `cycle-${cycle}-export.log`), exportDir, `ItemType:${langTypeId}`]);
    const exported = existsSync(join(exportDir, "imports.mf"));
    must("2.aras-pkg export ItemType:Language through run --lease", exp.code === 0 && exported, `exit ${exp.code}; imports.mf ${exported ? "written (extracted to the record folder)" : "missing"}`, since(t));
    // The engine's version probe names the server it logged in to: the registry's build for the flavor.
    let server: string | undefined;
    try {
      server = (JSON.parse(exp.stdout) as { server?: string }).server;
    } catch {
      server = undefined;
    }
    // The 14.x engines name the build (`14.0.9.36073`); the 12.0 engine names the release and service pack it read
    // (`12.0 SP9 Build 0`, ticket 54's run), which is the registry's release for 12sp9.
    const flavorInfo = getFlavor(flavor);
    const sameServer = server === flavorInfo.serverBuild || (server !== undefined && server.startsWith(`${flavorInfo.release} `));
    check("2.the server is the flavor's build", sameServer, `server ${server ?? "not in the summary"}, registry ${flavorInfo.serverBuild} (${flavorInfo.release}), engine ${options.engine}`);
    let goldenLanguages: string[] = [];
    if (options.importOptions1435) {
      const langs = await aras.apply(token, `<Item type="Language" action="get" select="code"/>`);
      goldenLanguages = [...langs.body.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1]!).sort();
      must("2.golden's languages", goldenLanguages.includes("en"), goldenLanguages.join(", ") || langs.fault || "none");
    }

    const before = { bin: binHashes(A.slot), config: configHash(A.slot), cers: signingCers(A.slot) };
    const oauthBefore = options.oauthState ? { files: oauthFiles(A.slot), grants: await persistedGrants(A.slot) } : undefined;

    // ---- 3. dirty it as a leaseholder could ---------------------------------------------------------------------
    const pkgName = `LIBSJS-SCRATCH-E2E-${TAG}`;
    const varName = `${pkgName}-Var`;
    const pkgDir = join(out, `cycle-${cycle}-package`);
    rmSync(pkgDir, { recursive: true, force: true });
    mkdirSync(join(pkgDir, pkgName, "Import", "Variable"), { recursive: true });
    writeFileSync(join(pkgDir, "imports.mf"), `<imports>\n  <package name="${pkgName}" path="${pkgName}\\Import" />\n</imports>\n`);
    writeFileSync(
      join(pkgDir, pkgName, "Import", "Variable", `${varName}.xml`),
      `<AML>\n <Item type="Variable" id="${newItemId()}" action="add">\n  <default_value>${tag}</default_value>\n  <name>${varName}</name>\n </Item>\n</AML>\n`,
    );
    t = Date.now();
    const imp = await cli(["run", "--lease", A.lease_id, "--", "node", options.arasPkg, "import", "--engine", options.engine, "--log", join(out, `cycle-${cycle}-import.log`), join(pkgDir, "imports.mf")]);
    must("3.aras-pkg import of a LIBSJS-SCRATCH package", imp.code === 0, `exit ${imp.code}: ${oneLine(imp).slice(0, 200)}`, since(t));

    // 14.35's AML batch mode and collected errors: five Variables (no Relationships, so batched), read in file order and
    // sent two at a time. The fourth repeats the second's name, which the server refuses, so its batch fails and falls
    // back to one by one: the third is applied, the fourth's error is collected, and the run goes on to the fifth. The
    // names stay under Variable's 32 characters.
    const batchPkg = `LIBSJS-SCRATCH-B-${TAG}`;
    const batchVars = [1, 2, 3, 5].map((i) => `AH-E2E-${tag}-B${i}`);
    if (options.importOptions1435) {
      const batchDir = join(out, `cycle-${cycle}-batch`);
      rmSync(batchDir, { recursive: true, force: true });
      mkdirSync(join(batchDir, batchPkg, "Import", "Variable"), { recursive: true });
      writeFileSync(join(batchDir, "imports.mf"), `<imports>\n  <package name="${batchPkg}" path="${batchPkg}\\Import" />\n</imports>\n`);
      const [b1, b2, b3, b5] = batchVars as [string, string, string, string];
      for (const [file, name] of [["B1", b1], ["B2", b2], ["B3", b3], ["B4", b2], ["B5", b5]]) {
        writeFileSync(
          join(batchDir, batchPkg, "Import", "Variable", `AH-E2E-${tag}-${file}.xml`),
          `<AML>\n <Item type="Variable" id="${newItemId()}" action="add">\n  <default_value>${tag}</default_value>\n  <name>${name}</name>\n </Item>\n</AML>\n`,
        );
      }
      const extra = goldenLanguages.length > 1 ? ["--languages", goldenLanguages.join(",")] : [];
      const batchLog = join(out, `cycle-${cycle}-batch-import.log`);
      t = Date.now();
      const batch = await cli(["run", "--lease", A.lease_id, "--", "node", options.arasPkg, "import", "--engine", options.engine, "--json", "--batch", "--batch-max", "2", "--collect-errors", "--max-errors", "5", ...extra, "--log", batchLog, join(batchDir, "imports.mf")]);
      let summary: { result?: string; batch?: { size?: number }; collectErrors?: { limit?: number }; messages?: { errors?: number } } = {};
      try {
        summary = JSON.parse(batch.stdout) as typeof summary;
      } catch {
        summary = {};
      }
      // A collected error ends the run as failed (exit 1), after every item was tried.
      const ranAsAsked = batch.code === 1 && summary.result === "failed" && summary.batch?.size === 2 && summary.collectErrors?.limit === 5 && (summary.messages?.errors ?? 0) > 0;
      const log = existsSync(batchLog) ? readFileSync(batchLog, "utf8") : "";
      const fellBack = /Error of import in AML batch mode/.test(log) && /Try to execute AML one by one/.test(log);
      must(
        "3.aras-pkg import --batch --batch-max 2 --collect-errors (14.35 only)",
        ranAsAsked && fellBack,
        `exit ${batch.code}, result ${summary.result}, batch ${summary.batch?.size}, collect-errors ${summary.collectErrors?.limit}, errors ${summary.messages?.errors}; the failed batch fell back to one by one: ${fellBack}`,
        since(t),
      );
      const counts = await Promise.all(batchVars.map(async (name) => (await aras.apply(token, `<Item type="Variable" action="get" select="id"><name>${name}</name></Item>`)).body.match(/<Item /g)?.length ?? 0));
      must("3.every good item of the batch import is there once, the one after the error too", counts.every((n) => n === 1), batchVars.map((name, i) => `${name.slice(-2)} x${counts[i]}`).join(", "));
      record("3.--languages", true, 0, extra.length > 0 ? `the batch import ran with --languages ${goldenLanguages.join(",")}` : `not run: golden has only ${goldenLanguages.join(", ")}`);
    }

    const partNumber = `ARASHOUSE-E2E-${TAG}`;
    const addPart = await aras.apply(token, `<Item type="Part" action="add"><item_number>${partNumber}</item_number><name>arashouse e2e</name></Item>`);
    must("3.add an item (Part) through the API", addPart.ok, addPart.ok ? partNumber : addPart.fault ?? "");
    const langCode = "zz";
    const addLang = await aras.apply(token, `<Item type="Language" action="add"><code>${langCode}</code><name>arashouse e2e ${tag}</name><suffix>_${langCode}</suffix></Item>`);
    must("3.add a Language", addLang.ok, addLang.ok ? `code ${langCode}` : addLang.fault ?? "");
    const userLogin = `arashouse_e2e_${tag}`;
    const addUser = await aras.apply(token, `<Item type="User" action="add"><login_name>${userLogin}</login_name><first_name>arashouse</first_name><last_name>e2e</last_name><logon_enabled>0</logon_enabled></Item>`);
    must("3.add a User", addUser.ok, addUser.ok ? userLogin : addUser.fault ?? "");

    const vaultOf = await aras.apply(token, `<Item type="User" action="get" select="default_vault"><login_name>root</login_name></Item>`);
    const vaultId = /<default_vault[^>]*>([0-9A-F]{32})</.exec(vaultOf.body)?.[1] ?? /<default_vault[^>]*>[\s\S]*?<Item[^>]*\bid="([0-9A-F]{32})"/.exec(vaultOf.body)?.[1];
    must("3.root's default vault", vaultId !== undefined, vaultId ?? vaultOf.fault ?? "none");
    const fileName = `arashouse-e2e-${tag}.txt`;
    const up = await aras.upload(token, vaultId!, fileName, Buffer.from(`arashouse e2e vault file ${tag}\n`));
    const fileBack = await aras.apply(token, `<Item type="File" action="get" select="filename" id="${up.id}"/>`);
    must("3.upload a file into the vault", up.ok && fileBack.ok, up.ok ? `File ${up.id.slice(0, 8)} ${fileName}` : up.fault ?? "");

    const methodName = `AH_E2E_${TAG}`;
    const addMethod = await aras.apply(token, `<Item type="Method" action="add"><name>${methodName}</name><method_type>C#</method_type><method_code><![CDATA[${methodCode()}]]></method_code></Item>`);
    must("3.add a server Method", addMethod.ok, addMethod.ok ? methodName : addMethod.fault ?? "");
    t = Date.now();
    const dirt = await aras.apply(token, `<Item type="Method" action="${methodName}"><mode>dirt</mode><tag>${tag}</tag></Item>`);
    const dll = /dll=([^<]+)</.exec(dirt.body)?.[1];
    must("3.the Method writes into the tree (Client file, Server\\temp file, config value, DLL under Server\\bin)", dirt.ok && dll !== undefined, dirt.ok ? `replaced ${dll}` : dirt.fault ?? "", since(t));
    const clientFile = join(slotDir(A.slot), "Innovator/Client", fileName);
    const tempFile = join(slotDir(A.slot), "Innovator/Server/temp", fileName);
    const dirtied = { client: existsSync(clientFile), temp: existsSync(tempFile), config: configHash(A.slot) !== before.config, dll: binHashes(A.slot).get(dll!) !== before.bin.get(dll!) };
    must("3.the tree is dirty (read back from WSL)", Object.values(dirtied).every(Boolean), JSON.stringify(dirtied));

    let offline: Login | undefined;
    if (oauthBefore) {
      offline = await aras.login("root", A.password, "offline_access");
      must("3.a refresh token issued to the lease (offline_access)", offline.ok && offline.refreshToken !== undefined, offline.ok ? (offline.refreshToken ? "issued" : "no refresh token") : offline.detail);
      const oauthDirt = await aras.apply(token, `<Item type="Method" action="${methodName}"><mode>oauth</mode><tag>${tag}</tag></Item>`);
      must("3.the Method writes OAuth runtime files (key-*.xml, *.sqlite)", oauthDirt.ok, oauthDirt.ok ? `key-arashouse-e2e-${tag}.xml, arashouse-e2e-${tag}.sqlite` : oauthDirt.fault ?? "");
      const grants = await persistedGrants(A.slot);
      const files = oauthFiles(A.slot);
      const oauthDirty = { grants: grants > oauthBefore.grants, key: files.has(`key-arashouse-e2e-${tag}.xml`), sqlite: files.has(`arashouse-e2e-${tag}.sqlite`) };
      must("3.the OAuth state is dirty (read back from WSL)", Object.values(oauthDirty).every(Boolean), `${JSON.stringify(oauthDirty)}; persisted grants ${oauthBefore.grants} before, ${grants} now`);
    }
    record("3.the leased slot's memory", true, 0, await slotMemory(flavor, slotNumber(A.slot)));

    // ---- 4. return: at once, not handed out ---------------------------------------------------------------------
    const ret = await cli(["return", A.lease_id]);
    check("4.return exits at once", ret.code === 0 && ret.ms < 10_000, `exit ${ret.code} in ${(ret.ms / 1000).toFixed(2)} s: ${oneLine(ret)}`, ret.ms);
    const afterReturn = await rowOf(A.slot);
    check("4.the returned slot is dirty or resetting", afterReturn?.status === "dirty" || afterReturn?.status === "resetting", `${A.slot} ${afterReturn?.status}`);
    const b = await get(`e2e-${cycle}-b`, RAM_WAIT);
    must("4.a concurrent get gets the other slot", b.grant !== undefined && b.grant.slot !== A.slot, b.grant ? `${b.grant.slot}` : oneLine(b.run), b.run.ms);
    const B = b.grant!;
    const busy = await get(`e2e-${cycle}-c`, ["--wait", "0"]);
    check("4.get --wait 0 with both busy exits 3", busy.run.code === 3 && !/free RAM/.test(oneLine(busy.run)), `exit ${busy.run.code}: ${oneLine(busy.run)}`, busy.run.ms);

    // ---- 5. the reset ------------------------------------------------------------------------------------------
    const freed = await waitFor(A.slot, ["free"], 15 * 60_000, ["quarantined"]);
    must("5.the returned slot is reset", freed.row?.status === "free", `${A.slot} ${freed.row?.status} after ${(freed.ms / 1000).toFixed(1)} s, last_reset_ms ${freed.row?.last_reset_ms}${freed.row?.quarantine_reason ? `: ${freed.row.quarantine_reason}` : ""}`, freed.ms);
    record("5.timing breakdown", true, 0, lastResetLine(A.slot));

    // ---- 6. the same slot again, clean ---------------------------------------------------------------------------
    t = Date.now();
    const health = await host.healthCheck({ flavor, slot: Number(slotNumber(A.slot)) });
    // `baseline verify` at the reset path's `fast` level, through the broker, which names the golden manifest's hash.
    const verify = await host.baselineVerify(flavor, { level: "fast" });
    const goldenHash = verify.ok ? verify.goldenHash : undefined;
    const stamp = JSON.parse(readFileSync(join(slotDir(A.slot), ".arashouse-slot.json"), "utf8")) as { goldenHash?: string; golden_hash?: string };
    const stampHash = stamp.goldenHash ?? stamp.golden_hash;
    check(
      "6.baseline verify fast, the stamp and the database marker agree",
      health.ok && goldenHash !== undefined && health.marker?.goldenHash === goldenHash && stampHash === goldenHash,
      `health ${health.ok ? "ok" : health.detail}; verify ${goldenHash?.slice(0, 12)}; marker ${health.marker?.goldenHash?.slice(0, 12)}; stamp ${stampHash?.slice(0, 12)}`,
      since(t),
    );
    const a2 = await get(`e2e-${cycle}-a2`, RAM_WAIT);
    must("6.get the same physical slot again", a2.grant?.slot === A.slot, a2.grant ? a2.grant.slot : oneLine(a2.run), a2.run.ms);
    const A2 = a2.grant!;
    const aras2 = new ArasClient(A2.url, A2.database);
    const oldLogin = await aras2.login("root", A.password);
    check("6.the old lease's password fails", !oldLogin.ok, oldLogin.ok ? "it logged in" : oldLogin.detail);
    const newLogin = await aras2.login("root", A2.password);
    must("6.the new lease's password works", newLogin.ok, newLogin.ok ? "token issued" : newLogin.detail);
    const token2 = (newLogin as { token: Secret }).token;
    const ootbA2 = await ootbLogsIn(A2.slot);
    if (ootbA2) check("6.the golden backup's password fails", !ootbA2.loggedIn, ootbA2.line);

    const gone = async (what: string, aml: string) => {
      const r = await aras2.apply(token2, aml);
      check(`6.${what} is gone`, isNoItems(r), r.ok ? "still there" : r.fault ?? "");
    };
    await gone("the imported package's item", `<Item type="Variable" action="get" select="id"><name>${varName}</name></Item>`);
    await gone("the imported package's definition", `<Item type="PackageDefinition" action="get" select="id"><name>${pkgName}</name></Item>`);
    if (options.importOptions1435) {
      for (const name of batchVars) await gone(`the batch import's ${name.slice(-2)}`, `<Item type="Variable" action="get" select="id"><name>${name}</name></Item>`);
      await gone("the batch import's package definition", `<Item type="PackageDefinition" action="get" select="id"><name>${batchPkg}</name></Item>`);
    }
    await gone("the API item", `<Item type="Part" action="get" select="id"><item_number>${partNumber}</item_number></Item>`);
    await gone("the Language", `<Item type="Language" action="get" select="id"><code>${langCode}</code></Item>`);
    await gone("the User", `<Item type="User" action="get" select="id"><login_name>${userLogin}</login_name></Item>`);
    await gone("the uploaded File", `<Item type="File" action="get" select="id" id="${up.id}"/>`);
    await gone("the Method", `<Item type="Method" action="get" select="id"><name>${methodName}</name></Item>`);

    const after = { bin: binHashes(A2.slot), config: configHash(A2.slot) };
    check("6.the Client file is gone", !existsSync(clientFile), clientFile.slice(ROOT_WSL.length));
    const temp = readdirSync(join(slotDir(A2.slot), "Innovator/Server/temp"));
    check("6.Server\\temp holds nothing of the lease", !temp.some((f) => f.includes("arashouse-e2e")), `${temp.length} entries, none of the lease's`);
    check("6.the DLL equals golden's (as provisioned)", after.bin.get(dll!) === before.bin.get(dll!), dll!);
    const binSame = after.bin.size === before.bin.size && [...before.bin].every(([f, h]) => after.bin.get(f) === h);
    check("6.Server\\bin equals the provisioned set", binSame, `${after.bin.size} DLLs`);
    check("6.the config equals golden's rendering", after.config === before.config, "InnovatorServerConfig.xml (compared by SHA-256, not printed)");

    // The vault folder is the broker's and the pool's only: a probe Method on the new lease counts its files.
    const addProbe = await aras2.apply(token2, `<Item type="Method" action="add"><name>${methodName}</name><method_type>C#</method_type><method_code><![CDATA[${methodCode()}]]></method_code></Item>`);
    const probe = addProbe.ok
      ? await aras2.apply(token2, `<Item type="Method" action="${methodName}"><mode>probe</mode><tag>${tag}</tag><vault>${xmlText(`${ROOT_WIN}\\vaults\\${flavor}-${slotNumber(A2.slot)}`)}</vault></Item>`)
      : addProbe;
    const vaultFiles = /vault=(-?\d+)/.exec(probe.body)?.[1];
    check("6.the vault is empty", vaultFiles === "0", vaultFiles !== undefined ? `${vaultFiles} files` : probe.fault ?? "");

    if (oauthBefore) {
      const files = oauthFiles(A2.slot);
      const lease = [...files.keys()].filter((f) => f.includes("arashouse-e2e"));
      check("6.the lease's OAuth runtime files are gone", lease.length === 0, lease.length === 0 ? `${files.size} runtime files, none of the lease's` : lease.join(", "));
      const keys = (m: Map<string, string>) => [...m].filter(([f]) => /^key-/i.test(f)).sort().join(";");
      check("6.the OAuth data-protection keys equal the provisioned ones", keys(files) === keys(oauthBefore.files), `${[...files.keys()].filter((f) => /^key-/i.test(f)).length} key files (compared by SHA-256, not printed)`);
      const grants = await persistedGrants(A2.slot);
      check("6.the OAuth SQLite file holds no grant of the lease", grants === oauthBefore.grants, `persisted grants ${grants}, ${oauthBefore.grants} before the dirt`);
      const refreshed = offline?.ok && offline.refreshToken ? await aras2.refresh(offline.refreshToken) : undefined;
      check("6.the old lease's refresh token is refused", refreshed !== undefined && !refreshed.ok, refreshed === undefined ? "no refresh token" : refreshed.ok ? "a new access token was issued" : refreshed.detail);
    }

    // An access token is a self-contained JWT (accessTokenLifetime 3600 s): only the signing certificate the reset made new
    // (ticket 54) stops the old lease's from being answered on the same slot. The token answered on lease A at step 3.
    const cersAfter = signingCers(A2.slot);
    const newCer = [...cersAfter.values()];
    check(
      "6.the slot signs with a new OAuth certificate",
      cersAfter.size === before.cers.size && cersAfter.size > 0 && newCer.every((h) => h === newCer[0]) && [...before.cers.values()].every((h) => !newCer.includes(h)),
      `${cersAfter.size} copies of OAuthServer.cer, all one certificate, not lease A's (compared by SHA-256)`,
    );
    const oldToken = await aras2.apply(token, `<Item type="User" action="get" select="id"><login_name>root</login_name></Item>`);
    check("6.the old lease's access token is refused", !oldToken.ok, oldToken.ok ? "answered on the same slot after the reset" : `refused: ${oldToken.fault ?? ""}`);

    // ---- 7. kill the reset worker mid-reset ---------------------------------------------------------------------
    const ret2 = await cli(["return", A2.lease_id]);
    must("7.return", ret2.code === 0, oneLine(ret2), ret2.ms);
    t = Date.now();
    let worker: { pid: number } | undefined;
    while (!worker && since(t) < 60_000) {
      worker = resetRecord(A2.slot);
      if (!worker) await sleep(200);
    }
    must("7.a reset worker took the slot", worker !== undefined, worker ? `pid ${worker.pid}` : "no resetting record in 60 s");
    await sleep(4000);
    let killed = false;
    try {
      process.kill(worker!.pid, "SIGKILL");
      killed = true;
    } catch {
      killed = false;
    }
    await sleep(1000);
    const stuck = await rowOf(A2.slot);
    must("7.the worker was killed mid-reset", killed && stuck?.status === "resetting", `pid ${worker!.pid} killed ${(since(t) / 1000).toFixed(1)} s after the return; ${A2.slot} ${stuck?.status}`);
    t = Date.now();
    let a3: { run: CliRun; grant?: Grant };
    if (cycle % 2 === 0) {
      const fix = await cli(["doctor", "--fix", "--yes"]);
      const fixed = await waitFor(A2.slot, ["free"], 15 * 60_000, ["quarantined"]);
      check("7.doctor --fix recovers the slot", fixed.row?.status === "free", `doctor exit ${fix.code}; ${A2.slot} ${fixed.row?.status}${fixed.row?.quarantine_reason ? `: ${fixed.row.quarantine_reason}` : ""}`, since(t));
      a3 = await get(`e2e-${cycle}-a3`, RAM_WAIT);
    } else {
      a3 = await get(`e2e-${cycle}-a3`, ["--wait", "900"]);
    }
    must("7.the next get recovers and leases the slot", a3.grant?.slot === A2.slot, a3.grant ? `${a3.grant.slot} in ${(since(t) / 1000).toFixed(1)} s` : oneLine(a3.run), since(t));
    const A3 = a3.grant!;

    // ---- 8. quarantine: a reset that fails twice --------------------------------------------------------------
    // The lock is held by a process of the leaseholder's: as the slot's pool identity (`pool`), or the worker's own Windows
    // process on a file the Method wrote (`worker`, 14.x). A handle the worker opens from WSL in slots\ (where it may only
    // read) does not keep others out (docs/e2e-12sp9.md); one a Windows process opens does.
    const aras3 = new ArasClient(A3.url, A3.database);
    const login3 = await aras3.login("root", A3.password);
    must("8.root logs in to the third lease", login3.ok, login3.ok ? "token issued" : login3.detail);
    const token3 = (login3 as { token: Secret }).token;
    const addLocker = await aras3.apply(token3, `<Item type="Method" action="add"><name>${methodName}</name><method_type>C#</method_type><method_code><![CDATA[${methodCode()}]]></method_code></Item>`);
    const lockStarted = Date.now();
    const lockName = `Innovator\\Client\\arashouse-e2e-lock-${tag}.txt`;
    if (options.lockHolder === "worker") {
      const written = addLocker.ok ? await aras3.apply(token3, `<Item type="Method" action="${methodName}"><mode>lockfile</mode><tag>${tag}</tag></Item>`) : addLocker;
      must("8.the leaseholder's Method writes a file to lock", written.ok, written.ok ? lockName : written.fault ?? "");
      const lock = await holdLock(`${ROOT_WIN}\\slots\\${flavor}\\${slotNumber(A3.slot)}\\${lockName}`, LOCK_SECONDS);
      must("8.the worker's own Windows process holds it open with no sharing", lock.locked, lock.locked ? `${lockName}, for ${LOCK_SECONDS} s (pid ${lock.pid})` : lock.detail);
    } else {
      const locker = addLocker.ok ? await aras3.apply(token3, `<Item type="Method" action="${methodName}"><mode>lock</mode><tag>${tag}</tag><seconds>${LOCK_SECONDS}</seconds></Item>`) : addLocker;
      const lockPid = /pid=(\d+)/.exec(locker.body)?.[1];
      must("8.a leaseholder's process holds a slot file locked", locker.ok && lockPid !== undefined, locker.ok ? `${lockName}, no sharing, for ${LOCK_SECONDS} s (pid ${lockPid})` : locker.fault ?? "");
    }
    await sleep(5000);
    t = Date.now();
    const ret3 = await cli(["return", A3.lease_id]);
    must("8.return", ret3.code === 0, oneLine(ret3), ret3.ms);
    const q = await waitFor(A3.slot, ["quarantined"], LOCK_SECONDS * 1000, ["free"]);
    check("8.the slot is quarantined with the reason", q.row?.status === "quarantined" && Boolean(q.row.quarantine_reason), `${A3.slot} ${q.row?.status}: ${q.row?.quarantine_reason}`, since(t));
    const never = await get(`e2e-${cycle}-d`, ["--wait", "0"]);
    check("8.a quarantined slot is never handed out", never.run.code === 3 && !/free RAM/.test(oneLine(never.run)), `exit ${never.run.code}: ${oneLine(never.run)}`, never.run.ms);
    // The holder ends by itself; repair after it has.
    await sleep(Math.max(0, lockStarted + LOCK_SECONDS * 1000 + 15_000 - Date.now()));
    t = Date.now();
    const repair = await cli(["repair", A3.slot]);
    const repaired = await rowOf(A3.slot);
    check("8.repair clears it", repair.code === 0 && repaired?.status === "free", `exit ${repair.code}; ${A3.slot} ${repaired?.status}: ${oneLine(repair)}`, since(t));

    // ---- the second lease back, both free ---------------------------------------------------------------------
    const retB = await cli(["return", B.lease_id]);
    check("9.return the second lease", retB.code === 0, oneLine(retB), retB.ms);
    const freeB = await waitFor(B.slot, ["free"], 15 * 60_000, ["quarantined"]);
    check("9.the second slot is reset", freeB.row?.status === "free", `${B.slot} ${freeB.row?.status} after ${(freeB.ms / 1000).toFixed(1)} s; ${lastResetLine(B.slot)}`, freeB.ms);

    // ---- 9. the host as found, and no password anywhere -------------------------------------------------------
    const denyAfter = await denyListPrints();
    const changed = Object.keys({ ...denyBefore, ...denyAfter }).filter((k) => denyBefore[k] !== denyAfter[k]);
    check("9.deny-list objects unchanged", changed.length === 0, changed.length === 0 ? `${Object.keys(denyAfter).length} objects the same` : `changed: ${changed.join(", ")}`);
    const final = await status();
    // The cycle's two slots, as step 1: a pool with more (12sp9 x3, ticket 37) runs it with the others disabled.
    const left = final.filter((r) => r.slot === `${flavor}-01` || r.slot === `${flavor}-02`);
    check("9.the pool is left free", left.length === 2 && left.every((r) => r.status === "free"), left.map((r) => `${r.slot} ${r.status}`).join(", "));
    const places: Record<string, string> = {
      "state file": readFileSync(join(home, "state.json"), "utf8"),
      "events log": readFileSync(join(home, "events.log"), "utf8"),
      "status and every other command's output": outputs.join("\n"),
      "the cycle's record": readFileSync(logFile, "utf8"),
    };
    const leaks = Object.entries(places).filter(([, text]) => seenPasswords.some((p) => text.includes(p.reveal()))).map(([where]) => where);
    check("9.no lease password in the state file, the events log, status or the record", leaks.length === 0, leaks.length === 0 ? `${seenPasswords.length} passwords looked for in ${Object.keys(places).length} places` : `found in: ${leaks.join(", ")}`);
    // The broker's logs are Administrators-only: the passwords, now dead, go to the elevated audit-log check DPAPI-encrypted.
    const leakFile = `C:\\aras_installations\\staging\\e2e-${flavor}\\leak-cycle-${cycle}.dpapi`;
    const sealed = await runPs([
      "-Command",
      `$f = '${leakFile}'; New-Item -ItemType Directory -Force -Path (Split-Path $f) | Out-Null; [Console]::In.ReadToEnd() -split "\`r?\`n" | Where-Object { $_ } | ForEach-Object { ConvertTo-SecureString -String $_ -AsPlainText -Force | ConvertFrom-SecureString } | Set-Content -LiteralPath $f -Encoding ASCII`,
    ], seenPasswords.map((p) => `${p.reveal()}\n`).join(""));
    check("9.the lease passwords sealed for the elevated audit-log check", sealed.code === 0, sealed.code === 0 ? `${leakFile} holds ${seenPasswords.length} passwords, the input of test/host/audit-leak-check.ps1` : `exit ${sealed.code}: ${redact(sealed.stderr).slice(0, 400)}`);
  } catch (err) {
    if (!(err instanceof CycleFailed)) record("error", false, 0, String((err as Error)?.stack ?? err));
    else failures = Math.max(failures, 1);
  }
  // A check that failed can leave a lease the cycle did not mean to take (a `get` that should have been refused).
  for (const lease of [...held]) {
    const r = await cli(["return", lease]);
    record("cleanup.return a lease the cycle still held", r.code === 0, r.ms, oneLine(r));
  }
  record("cycle", failures === 0, since(t0), failures === 0 ? "passed" : `${failures} check(s) failed`);
  writeFileSync(join(out, `cycle-${cycle}.json`), `${JSON.stringify({ cycle, flavor, tag, records }, null, 2)}\n`);
  return records;
}

// ---- Windows helpers -----------------------------------------------------------------------------------------

async function toWindows(path: string): Promise<string> {
  const r = await runProcess("wslpath", ["-w", path]);
  return r.stdout.trim();
}

export function runProcess(cmd: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    // A command that does not read its stdin may end before the write lands: EPIPE then, which changes nothing.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

/**
 * Opens `path` (a Windows path) for reading with no sharing from a Windows process of the worker's, and keeps it open for
 * `seconds`, then ends. The path goes on stdin, so the process's command line names no slot folder and the quiesce, which
 * ends a slot's processes by their path or command line, leaves it alone. Resolves once the handle is open, or failed.
 */
function holdLock(path: string, seconds: number): Promise<{ locked: boolean; pid?: number; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$f = [IO.File]::Open([Console]::In.ReadLine(), 'Open', 'Read', 'None'); [Console]::Out.WriteLine('locked'); Start-Sleep -Seconds ${seconds}; $f.Close()`], {
      cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      if (d.toString("utf8").includes("locked")) resolve({ locked: true, pid: child.pid, detail: "locked" });
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ locked: false, detail: `exit ${code}: ${stderr.trim().slice(0, 300)}` }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${path}\n`);
  });
}

export const runPs = (args: string[], input?: string) => runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], input);

/**
 * A slot's memory, measured by process tree (spike 07: from 14.0 each running application is its own `Aras.Server.exe`,
 * `Aras.Client.exe` or `dotnet.exe` beside its `w3wp.exe`): the slot's pools' `w3wp.exe` and their children, and its agent
 * service. A worker cannot read another identity's command line, so the pools' processes come from IIS's `W3SVC_W3WP`
 * counter instances, named `<pid>_<pool>`. One line: the process count and the summed working set and private bytes.
 */
export async function slotMemory(flavor: FlavorKey, nn: string): Promise<string> {
  const r = await runPs([
    "-Command",
    `$ids = @((Get-Counter -ListSet W3SVC_W3WP).PathsWithInstances | ForEach-Object { if ($_ -match '\\((\\d+)_ah-${flavor}-${nn}-[a-z]+\\)') { [int]$Matches[1] } } | Sort-Object -Unique); ` +
      `$all = Get-CimInstance Win32_Process; $w = @($all | Where-Object { $ids -contains $_.ProcessId }); $kids = @($all | Where-Object { $ids -contains $_.ParentProcessId }); ` +
      `$svc = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -eq 'ArasHouseAgent_${flavor}_${nn}' -and $_.ProcessId -gt 0 } | ForEach-Object { $_.ProcessId }); ` +
      `$agent = @($all | Where-Object { $svc -contains $_.ProcessId }); ` +
      `$p = $w + $kids + $agent; $names = ($p | Group-Object Name | Sort-Object Name | ForEach-Object { [string]$_.Count + ' ' + $_.Name }) -join ', '; ` +
      `'{0} processes ({1}): {2:N0} MB working set, {3:N0} MB private' -f $p.Count, $names, (($p | Measure-Object WorkingSetSize -Sum).Sum / 1MB), (($p | Measure-Object PrivatePageCount -Sum).Sum / 1MB)`,
  ]);
  return r.code === 0 ? r.stdout.trim() : `not measured: exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`;
}

/**
 * The deny-list objects the worker can read without elevation: the SHA-256 of each of the captain's install roots'
 * `InnovatorServerConfig.xml` (read only, never printed) and the deny-listed agent services (name, start type, state).
 * The IIS objects need elevation; every provision and destroy fingerprints those in the broker (docs/provision.md).
 */
export async function denyListPrints(): Promise<Record<string, string>> {
  const prints: Record<string, string> = {};
  const { DENIED_INSTALL_ROOTS, DENIED_SERVICE_PREFIXES } = await import("../../src/core/guards.js");
  for (const root of DENIED_INSTALL_ROOTS) {
    const wsl = `/mnt/c/${root.slice(3).replace(/\\/g, "/")}/InnovatorServerConfig.xml`;
    let print = "absent";
    try {
      if (statSync(wsl).isFile()) print = sha256(readFileSync(wsl));
    } catch {
      print = existsSync(`/mnt/c/${root.slice(3).replace(/\\/g, "/")}`) ? "no readable config" : "absent";
    }
    prints[`install root ${root}`] = print;
  }
  const filter = DENIED_SERVICE_PREFIXES.map((p) => `$_.Name.StartsWith('${p}')`).join(" -or ");
  const r = await runPs(["-Command", `Get-Service | Where-Object { ${filter} } | Sort-Object Name | ForEach-Object { $_.Name + '|' + $_.StartType + '|' + $_.Status }`]);
  for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, ...rest] = line.split("|");
    prints[`service ${name}`] = rest.join("|");
  }
  return prints;
}
