// Ticket 43 on the real host: a leaseholder takes code, data and a package out of a leased slot, returns it, and the
// copies outlive the reset. Run from WSL, non-elevated, by test/host/extract-12sp9.test.ts (ARASHOUSE_TEST_EXTRACT=1);
// every step is recorded in `<out>/extract.json` and `.log` for docs/extract.md.
//
// It drives the built CLI (`dist/`) as a worker would. The slot is changed only as a leaseholder can (test/host/
// e2e-cycle.ts): a Part through the API, a LIBSJS-SCRATCH package imported with libs-js, and a server Method of its own
// that writes a file into `Innovator\Client` as the slot's pool identity. Every password is a Secret, so `redact`
// replaces it in each recorded line.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../src/core/redact.js";
import { Secret } from "../../src/core/secret.js";
import type { FlavorKey } from "../../src/core/flavors.js";
import { BrokerHost, interopTransport } from "../../src/host/index.js";
import { isHostError } from "../../src/host/errors.js";
import { repoRoot } from "../helpers.js";
import { ArasClient, isNoItems, newItemId } from "./aras-client.js";
import { denyListPrints, methodCode } from "./e2e-cycle.js";

const CLI = join(repoRoot, "dist/cli/index.js");
const ROOT_WSL = "/mnt/c/aras_installations";
const ROOT_WIN = "C:\\aras_installations";
const REMINDER = /^Returning slot [a-z0-9]+-\d{2}\. Its state will be discarded; anything you want to keep must already be out\.$/m;

export interface ExtractOptions {
  readonly flavor: FlavorKey;
  /** The libs-js engine for the flavor (`12.0` for 12sp9). */
  readonly engine: string;
  /** Where the record and the extracted copies go (outside the worktree). */
  readonly out: string;
  /** libs-js's built CLI, `dist/cli.js`. */
  readonly arasPkg: string;
}

interface StepRecord {
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

class Stop extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function runExtractCycle(options: ExtractOptions): Promise<StepRecord[]> {
  const { flavor, out } = options;
  const tag = randomBytes(4).toString("hex");
  const TAG = tag.toUpperCase();
  const records: StepRecord[] = [];
  const passwords: Secret[] = [];
  const outputs: string[] = [];
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const logFile = join(out, "extract.log");
  writeFileSync(logFile, `extract proof, ${flavor}, tag ${tag}, started ${new Date().toISOString()}\n`);
  let failures = 0;
  const record = (step: string, ok: boolean, ms: number, detail: string) => {
    const line = redact(detail);
    records.push({ step, ok, ms, detail: line });
    if (!ok) failures++;
    const text = `${ok ? "ok  " : "FAIL"} ${step} (${(ms / 1000).toFixed(1)} s): ${line}`;
    appendFileSync(logFile, `${text}\n`);
    console.log(text);
  };
  const check = (step: string, ok: boolean, detail: string, ms = 0) => record(step, ok, ms, detail);
  const must = (step: string, ok: boolean, detail: string, ms = 0) => {
    record(step, ok, ms, detail);
    if (!ok) throw new Stop(`${step}: ${redact(detail)}`);
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
        if (!(args[0] === "get" && args.includes("--json"))) outputs.push(stdout);
        outputs.push(stderr);
        resolve({ code, stdout, stderr, ms: Date.now() - started });
      });
    });
  const oneLine = (run: CliRun) => redact(`${run.stdout} ${run.stderr}`.replace(/\s+/g, " ").trim()).slice(0, 400);
  const rowOf = async (slot: string) => {
    const run = await cli(["status", "--json"]);
    return (JSON.parse(run.stdout) as { slots: { slot: string; status: string; extracted: boolean | null; quarantine_reason: string | null }[] }).slots.find((r) => r.slot === slot);
  };
  const host = new BrokerHost(interopTransport({ node: process.env.ARASHOUSE_WINDOWS_NODE || undefined }));
  const transport = interopTransport({ node: process.env.ARASHOUSE_WINDOWS_NODE || undefined });
  /** A request straight to the broker, past `BrokerHost`'s WSL-side guards: the broker must refuse it on its own. */
  const raw = async (slot: unknown, args: Record<string, unknown>): Promise<string> => {
    const answer = (await transport.call({ id: `extract-${tag}-${randomBytes(2).toString("hex")}`, verb: "backupDatabase", slot: slot as never, args }, 60_000)) as {
      ok: boolean;
      error?: { kind: string; message: string };
    };
    return answer.ok ? "answered ok" : `${answer.error?.kind}: ${answer.error?.message}`;
  };
  const t0 = Date.now();
  let leaseId: string | undefined;

  try {
    const denyBefore = await denyListPrints();
    check("deny-list before", Object.keys(denyBefore).length > 0, `${Object.keys(denyBefore).length} objects fingerprinted (names and hashes only)`);

    // ---- a lease, changed as a leaseholder can ---------------------------------------------------------------------
    const got = await cli(["get", flavor, "--holder", `extract-43-${tag}`, "--json", "--wait", "600"]);
    must("get --json", got.code === 0, got.code === 0 ? "leased" : oneLine(got), got.ms);
    const json = JSON.parse(got.stdout) as { slot: string; url: string; database: string; lease_id: string; password: string };
    const password = Secret.of(json.password, "lease-password");
    passwords.push(password);
    leaseId = json.lease_id;
    const slot = json.slot;
    const nn = slot.slice(slot.lastIndexOf("-") + 1);
    check("status: extracted false before any extract", (await rowOf(slot))?.extracted === false, `${slot}`);
    const aras = new ArasClient(json.url, json.database);
    const login = await aras.login("root", password);
    must("root logs in with the lease's password", login.ok, login.ok ? "token issued" : login.detail);
    const token = (login as { token: Secret }).token;

    const partNumber = `ARASHOUSE-EXTRACT-${TAG}`;
    const part = await aras.apply(token, `<Item type="Part" action="add"><item_number>${partNumber}</item_number><name>arashouse extract</name></Item>`);
    must("add a Part through the API", part.ok, part.ok ? partNumber : part.fault ?? "");

    const pkgName = `LIBSJS-SCRATCH-EXTRACT-${TAG}`;
    const varName = `${pkgName}-Var`;
    const pkgDir = join(out, "package-in");
    mkdirSync(join(pkgDir, pkgName, "Import", "Variable"), { recursive: true });
    writeFileSync(join(pkgDir, "imports.mf"), `<imports>\n  <package name="${pkgName}" path="${pkgName}\\Import" />\n</imports>\n`);
    writeFileSync(
      join(pkgDir, pkgName, "Import", "Variable", `${varName}.xml`),
      `<AML>\n <Item type="Variable" id="${newItemId()}" action="add">\n  <default_value>${tag}</default_value>\n  <name>${varName}</name>\n </Item>\n</AML>\n`,
    );
    const imp = await cli(["run", "--lease", leaseId, "--", "node", options.arasPkg, "import", "--engine", options.engine, "--log", join(out, "import.log"), join(pkgDir, "imports.mf")]);
    must("aras-pkg import of a LIBSJS-SCRATCH package", imp.code === 0, `exit ${imp.code}`, imp.ms);

    const methodName = `AH_EXTRACT_${TAG}`;
    const addMethod = await aras.apply(token, `<Item type="Method" action="add"><name>${methodName}</name><method_type>C#</method_type><method_code><![CDATA[${methodCode()}]]></method_code></Item>`);
    must("add a server Method", addMethod.ok, addMethod.ok ? methodName : addMethod.fault ?? "");
    const dirt = await aras.apply(token, `<Item type="Method" action="${methodName}"><mode>dirt</mode><tag>${tag}</tag></Item>`);
    must("the Method writes a file into Innovator\\Client (and the rest of its dirt)", dirt.ok, dirt.ok ? "written" : dirt.fault ?? "");
    const clientName = `arashouse-e2e-${tag}.txt`;
    const clientFile = join(ROOT_WSL, "slots", flavor, nn, "Innovator", "Client", clientName);
    must("the changed Client file reads back from WSL", existsSync(clientFile), clientFile.slice(ROOT_WSL.length));

    // ---- extract: code, data, a package ---------------------------------------------------------------------------
    const codeOut = join(out, "code");
    const code = await cli(["extract", "code", "--lease", leaseId, `Innovator/Client/${clientName}`, "--to", codeOut]);
    const codeCopy = join(codeOut, clientName);
    must("extract code: the changed Client file", code.code === 0 && existsSync(codeCopy), oneLine(code), code.ms);
    check("extract code: the copy is the leaseholder's file", readFileSync(codeCopy, "utf8") === `arashouse e2e dirt ${tag}`, "content compared");
    const config = await cli(["extract", "code", "--lease", leaseId, "InnovatorServerConfig.xml", "--to", codeOut]);
    check("extract code: InnovatorServerConfig.xml refused without --allow-config (exit 7)", config.code === 7 && !existsSync(join(codeOut, "InnovatorServerConfig.xml")), oneLine(config));
    const escape = await cli(["extract", "code", "--lease", leaseId, "../02", "--to", codeOut]);
    check("extract code: a path out of the slot refused (exit 7)", escape.code === 7, oneLine(escape));

    const bak = join(out, `db-${tag}.bak`);
    const db = await cli(["--verbose", "extract", "db", "--lease", leaseId, "--to", bak]);
    must("extract db: a COPY_ONLY backup of the slot's database", db.code === 0 && existsSync(bak), oneLine(db), db.ms);
    const bakBytes = readFileSync(bak);
    const header = bakBytes.subarray(0, 4).toString("ascii");
    const holdsPart = bakBytes.includes(Buffer.from(partNumber, "utf16le"));
    check("extract db: a SQL Server backup that holds the lease's Part", header === "TAPE" && holdsPart, `${(bakBytes.length / 1024 / 1024).toFixed(1)} MB, header ${header}, the Part's number ${holdsPart ? "found" : "missing"} in it`);
    const staged = join(ROOT_WSL, "staging", leaseId);
    check("extract db: the staged copy is deleted", !existsSync(staged), existsSync(staged) ? `${readdirSync(staged).join(", ")} left` : "staging\\<lease_id> gone");

    const pkgOut = join(out, "package-out");
    const exp = await cli(["run", "--lease", leaseId, "--", "node", options.arasPkg, "export", "--engine", options.engine, "--log", join(out, "export.log"), pkgOut, "--package", pkgName]);
    const exported = existsSync(join(pkgOut, "imports.mf")) && readdirSync(join(pkgOut), { recursive: true }).some((f) => String(f).endsWith(`${varName}.xml`));
    must("aras-pkg export --package of the scratch package through run --lease", exp.code === 0 && exported, `exit ${exp.code}; ${exported ? "imports.mf and the Variable written" : "incomplete"}`, exp.ms);
    check("status: extracted true after extract", (await rowOf(slot))?.extracted === true, slot);

    // ---- refusals ------------------------------------------------------------------------------------------------
    const other = (await (async () => {
      const run = await cli(["status", "--json"]);
      return (JSON.parse(run.stdout) as { slots: { slot: string; flavor: string; status: string }[] }).slots.find((r) => r.flavor === flavor && r.slot !== slot && r.status !== "leased");
    })())?.slot;
    if (other) {
      const ref = { flavor, slot: Number(other.slice(other.lastIndexOf("-") + 1)) };
      const notLeased = await raw(ref, { path: `${ROOT_WIN}\\staging\\${leaseId}\\other.bak` });
      check(`the broker refuses the backup of a slot that is not leased (${other})`, notLeased.startsWith("Refused: slot") && notLeased.includes("not leased"), notLeased);
    } else {
      check("the broker refuses the backup of a slot that is not leased", false, `no other ${flavor} slot that is not leased`);
    }
    const ownSlot = { flavor, slot: Number(nn) };
    const otherLease = await raw(ownSlot, { path: `${ROOT_WIN}\\staging\\${"f".repeat(32)}\\x.bak` });
    check("the broker refuses a path in another lease's staging folder", otherLease.startsWith("Refused"), otherLease);
    const golden = await raw(ownSlot, { path: `${ROOT_WIN}\\golden\\${flavor}\\db\\x.bak` });
    check("the broker refuses a path outside staging", golden.startsWith("Refused"), golden);
    for (const denied of [{ flavor: "OLM_Local", slot: 1 }, { flavor: "olm", slot: 1 }, { flavor: "prod", slot: 1 }]) {
      const answer = await raw(denied, { path: `${ROOT_WIN}\\staging\\${leaseId}\\x.bak` });
      check(`the broker refuses the deny-list name ${denied.flavor}`, answer.startsWith("Refused"), answer);
      const viaHost = await host.backupDatabase(denied as never, `${ROOT_WIN}\\staging\\${leaseId}\\x.bak`).then(() => "answered ok", (e: unknown) => (isHostError(e, "Refused") ? "Refused" : String(e)));
      check(`BrokerHost refuses the deny-list name ${denied.flavor} before sending`, viaHost === "Refused", viaHost);
    }
    check("no backup was left in the lease's staging folder", !existsSync(staged), existsSync(staged) ? readdirSync(staged).join(", ") : "none");

    // ---- return, the reset, and the copies outlive it -------------------------------------------------------------
    const hashes = { code: sha256(readFileSync(codeCopy)), db: sha256(bakBytes), pkg: sha256(readFileSync(join(pkgOut, "imports.mf"))) };
    const ret = await cli(["return", leaseId]);
    check("return prints the reminder on stderr", ret.code === 0 && REMINDER.test(ret.stderr) && !REMINDER.test(ret.stdout), oneLine(ret), ret.ms);
    leaseId = undefined;
    const started = Date.now();
    let row = await rowOf(slot);
    while (row && row.status !== "free" && row.status !== "quarantined" && Date.now() - started < 15 * 60_000) {
      await sleep(3000);
      row = await rowOf(slot);
    }
    must("the returned slot is reset", row?.status === "free", `${slot} ${row?.status} after ${((Date.now() - started) / 1000).toFixed(1)} s${row?.quarantine_reason ? `: ${row.quarantine_reason}` : ""}`, Date.now() - started);
    check("the Client file is gone from the slot", !existsSync(clientFile), clientFile.slice(ROOT_WSL.length));
    const health = await host.healthCheck({ flavor, slot: Number(nn) });
    check("the slot's health check passes (tree, marker and stamp from golden)", health.ok, health.detail);
    const again = await cli(["get", flavor, "--holder", `extract-43-${tag}-b`, "--json", "--wait", "600"]);
    if (again.code === 0) {
      const g = JSON.parse(again.stdout) as { slot: string; url: string; database: string; lease_id: string; password: string };
      const p = Secret.of(g.password, "lease-password");
      passwords.push(p);
      const a2 = new ArasClient(g.url, g.database);
      const l2 = await a2.login("root", p);
      if (l2.ok && g.slot === slot) {
        const t2 = (l2 as { token: Secret }).token;
        const partGone = await a2.apply(t2, `<Item type="Part" action="get" select="id"><item_number>${partNumber}</item_number></Item>`);
        check("the next lease of the slot has no Part of the last one", isNoItems(partGone), partGone.ok ? "still there" : partGone.fault ?? "");
        const pkgGone = await a2.apply(t2, `<Item type="PackageDefinition" action="get" select="id"><name>${pkgName}</name></Item>`);
        check("the next lease of the slot has no scratch package", isNoItems(pkgGone), pkgGone.ok ? "still there" : pkgGone.fault ?? "");
      } else {
        check("the next lease of the slot", false, l2.ok ? `got ${g.slot}, not ${slot}` : l2.detail);
      }
      const back = await cli(["return", g.lease_id, "--quiet"]);
      check("return --quiet prints no reminder", back.code === 0 && !REMINDER.test(back.stderr), oneLine(back));
    } else {
      check("the next lease of the slot", false, oneLine(again));
    }
    const after = { code: sha256(readFileSync(codeCopy)), db: sha256(readFileSync(bak)), pkg: sha256(readFileSync(join(pkgOut, "imports.mf"))) };
    check("the extracted copies are intact after the return and the reset", JSON.stringify(after) === JSON.stringify(hashes), "code file, database backup and package export, by SHA-256");

    const denyAfter = await denyListPrints();
    const changed = Object.keys({ ...denyBefore, ...denyAfter }).filter((k) => denyBefore[k] !== denyAfter[k]);
    check("deny-list objects unchanged", changed.length === 0, changed.length === 0 ? `${Object.keys(denyAfter).length} objects the same` : `changed: ${changed.join(", ")}`);
    const leaked = outputs.some((text) => passwords.some((p) => text.includes(p.reveal()))) || passwords.some((p) => readFileSync(logFile, "utf8").includes(p.reveal()));
    check("no lease password in any command's output or the record", !leaked, `${passwords.length} passwords looked for`);
  } catch (err) {
    if (!(err instanceof Stop)) record("error", false, 0, String((err as Error)?.stack ?? err));
    if (leaseId) {
      const r = await cli(["return", leaseId, "--quiet"]);
      record("cleanup.return the lease", r.code === 0, r.ms, oneLine(r));
    }
  }
  record("extract proof", failures === 0, Date.now() - t0, failures === 0 ? "passed" : `${failures} check(s) failed`);
  writeFileSync(join(out, "extract.json"), `${JSON.stringify({ flavor, tag, records }, null, 2)}\n`);
  return records;
}
