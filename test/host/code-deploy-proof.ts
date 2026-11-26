// Ticket 40's proof on the real host (docs/code-deploy.md): a code deploy onto a `12sp9` lease, run natively on Windows or from WSL,
// non-elevated, by test/host/code-deploy.test.ts (ARASHOUSE_TEST_DEPLOY=1). Every step is a line in
// `<out>/deploy-proof.log` and `.json`.
//
// 1. `get --code` with a folder (a client file, a probe page and the probe DLL, v1) and a zip (a golden DLL of
//    `Server\bin` with bytes appended): both served, read from WSL through the slot's URL, and the slot's files read
//    back (the worker may read `slots\`).
// 2. `deploy-code` of the probe DLL v2: the page now answers v2 (the replaced DLL is served).
// 3. Refusals, each changing nothing: by the CLI (a zip entry with `..`, a source with a junction, the server config
//    without `--allow-config`), and by the broker itself through `BrokerHost` with trees staged by hand (a junction to
//    `secrets\`, a hard link, the server config, a `..` in deploy.json, another lease's folder).
// 4. `return --wait`: the reset's `fast` verify passes (the slot is free again) and every deployed file is gone or
//    golden's again; the broker's health check of the free slot passes its tree check.
// 5. `get --atomic --code` of a broken `Client\web.config`: the warm-up fails, the lease is returned and reset, and get
//    exits 10; the slot is free again with golden's web.config.
// The deny-list objects the worker can read are fingerprinted before and after.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../src/core/redact.js";
import { Secret } from "../../src/core/secret.js";
import { stagingDir } from "../../src/core/names.js";
import { buildZip } from "../../src/core/zip.fixture.js";
import { BrokerHost } from "../../src/host/index.js";
import { ROOT_LOCAL, toLocal, transport, windowsPathOf } from "./local.js";
import { isHostError } from "../../src/host/errors.js";
import { windowsTempDir } from "../../src/host/msi.js";
import { repoRoot } from "../helpers.js";
import { ArasClient } from "./aras-client.js";
import { denyListPrints, runProcess } from "./e2e-cycle.js";

const CLI = join(repoRoot, "dist/cli/index.js");
const CSC = toLocal("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe");
/** A golden DLL of the 12sp9 `Server\bin` that the e2e cycle appended bytes to as well (docs/e2e-12sp9.md). */
const GOLDEN_DLL = "Innovator/Server/bin/VeracodeAttributes.dll";

export interface ProofRecord {
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

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export async function runDeployProof(out: string): Promise<ProofRecord[]> {
  mkdirSync(out, { recursive: true });
  const tag = randomBytes(4).toString("hex");
  const logFile = join(out, "deploy-proof.log");
  writeFileSync(logFile, `ticket 40 deploy proof, tag ${tag}, started ${new Date().toISOString()}\n`);
  const records: ProofRecord[] = [];
  const passwords: Secret[] = [];
  const outputs: string[] = [];
  const record = (step: string, ok: boolean, detail: string, ms = 0) => {
    const line = redact(detail).replace(/\s+/g, " ").slice(0, 600);
    records.push({ step, ok, ms, detail: line });
    const text = `${ok ? "ok  " : "FAIL"} ${step} (${(ms / 1000).toFixed(1)} s): ${line}`;
    appendFileSync(logFile, `${text}\n`);
    console.log(text);
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
  const oneLine = (run: CliRun) => `exit ${run.code}: ${`${run.stdout} ${run.stderr}`.replace(/\s+/g, " ").trim()}`.slice(0, 500);
  const fetchText = async (url: string): Promise<{ status: number; text: string }> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: 0, text: (err as Error).message };
    }
  };
  const slotFile = (slot: string, rel: string) => join(ROOT_LOCAL, "slots", "12sp9", slot.slice(-2), ...rel.split("/"));
  const hashOf = (path: string) => (existsSync(path) ? sha256(readFileSync(path)) : "absent");
  const broker = new BrokerHost(transport());

  // ---- the sources ----------------------------------------------------------------------------------------
  const winTemp = await windowsTempDir();
  const scratch = join(winTemp, `arashouse-40-${tag}`);
  mkdirSync(scratch, { recursive: true });
  const compile = async (version: string): Promise<Buffer> => {
    // The file name must be the assembly's (ASP.NET loads every bin assembly by its file name), so each version gets its own folder.
    mkdirSync(join(scratch, version), { recursive: true });
    const cs = join(scratch, version, "ArasHouseProbe.cs");
    const dll = join(scratch, version, "ArasHouseProbe.dll");
    writeFileSync(cs, `namespace ArasHouseProbe { public static class Marker { public const string Tag = "${version}-${tag}"; } }\n`);
    const win = (p: string) => windowsPathOf(p);
    const r = await runProcess(CSC, ["/nologo", "/target:library", `/out:${await win(dll)}`, await win(cs)]);
    if (r.code !== 0) throw new Error(`csc failed: ${r.stdout} ${r.stderr}`);
    return readFileSync(dll);
  };
  const v1 = await compile("v1");
  const v2 = await compile("v2");
  const page = `<%@ Page Language="C#" %><%= ArasHouseProbe.Marker.Tag %>`;
  const clientName = `arashouse-40-${tag}.txt`;
  const pageName = `arashouse-40-${tag}.aspx`;
  const overlay = join(out, "overlay");
  rmSync(overlay, { recursive: true, force: true });
  mkdirSync(join(overlay, "Client"), { recursive: true });
  mkdirSync(join(overlay, "Server", "bin"), { recursive: true });
  writeFileSync(join(overlay, "Client", clientName), `arashouse 40 ${tag}`);
  writeFileSync(join(overlay, "Server", pageName), page);
  writeFileSync(join(overlay, "Server", "bin", "ArasHouseProbe.dll"), v1);
  const v2dir = join(out, "probe-v2");
  rmSync(v2dir, { recursive: true, force: true });
  mkdirSync(v2dir);
  writeFileSync(join(v2dir, "ArasHouseProbe.dll"), v2);

  const deny0 = await denyListPrints();
  record("deny-list before", true, `${Object.keys(deny0).length} objects fingerprinted`);

  // ---- 1. get --code ----------------------------------------------------------------------------------------
  const status0 = JSON.parse((await cli(["status", "--json"])).stdout) as { slots: { slot: string; status: string }[] };
  const free = status0.slots.filter((s) => s.slot.startsWith("12sp9-") && s.status === "free").map((s) => s.slot);
  if (free.length === 0) throw new Error("no 12sp9 slot is free");
  const goldenDll = readFileSync(slotFile(free[0]!, GOLDEN_DLL));
  const goldenClientConfig = hashOf(slotFile(free[0]!, "Innovator/Client/web.config"));
  const zip = join(out, "golden-dll.zip");
  const patched = Buffer.concat([goldenDll, Buffer.from(`arashouse-40-${tag}`)]);
  writeFileSync(zip, buildZip([{ name: "VeracodeAttributes.dll", data: patched }]));

  const got = await cli(["get", "12sp9", "--holder", `deploy-40-${tag}`, "--json", "--code", overlay, "--code", `${zip}:Innovator/Server/bin`]);
  if (got.code !== 0) {
    record("get --code", false, oneLine(got), got.ms);
    // Exit 10 keeps the lease (the holder is mid-development): give it back, so a failed proof leaves no lease behind.
    if (got.code === 10) await cli(["return", (JSON.parse(got.stdout) as { lease_id: string }).lease_id, "--quiet"]);
    return records;
  }
  const grant = JSON.parse(got.stdout) as { slot: string; url: string; database: string; lease_id: string; password: string; bootstrap: { code: { ok: boolean; files: number; detail: string }[] } };
  const password = Secret.of(grant.password, "lease-password");
  passwords.push(password);
  const leaseId = grant.lease_id;
  let held = true;
  try {
    record("get --code (a folder, then a zip into Server\\bin)", grant.bootstrap.code.every((c) => c.ok), `${grant.slot}: ${grant.bootstrap.code.map((c) => `${c.files} files: ${c.detail}`).join(" | ")}`, got.ms);
    const client = await fetchText(`${grant.url}/Client/${clientName}`);
    record("the client file is served", client.status === 200 && client.text === `arashouse 40 ${tag}`, `GET Client/${clientName}: ${client.status} "${client.text.slice(0, 40)}"`);
    const probe1 = await fetchText(`${grant.url}/Server/${pageName}`);
    record("the probe DLL (v1) is served", probe1.status === 200 && probe1.text.trim() === `v1-${tag}`, `GET Server/${pageName}: ${probe1.status} "${probe1.text.trim().slice(0, 60)}"`);
    record("the golden DLL is replaced", hashOf(slotFile(grant.slot, GOLDEN_DLL)) === sha256(patched), `${GOLDEN_DLL} is the deployed bytes (${patched.length}, golden ${goldenDll.length})`);
    const login = await new ArasClient(grant.url, grant.database).login("root", password);
    record("root logs in with the lease's password after the deploys", login.ok, login.ok ? "token issued" : login.detail);
    const state = JSON.parse(readFileSync(join(process.env.ARASHOUSE_HOME as string, "state.json"), "utf8")) as { slots: { id: string; lease?: { bootstrap?: Record<string, unknown> } }[] };
    const lease = state.slots.find((s) => s.id === grant.slot)?.lease;
    record("the lease records files and a manifest hash", typeof lease?.bootstrap?.code === "string" && lease.bootstrap.code_deploys === 2, JSON.stringify(lease?.bootstrap ?? null));

    // ---- 2. deploy-code: the replaced DLL is served ------------------------------------------------------
    const dep = await cli(["deploy-code", "--lease", leaseId, "--json", `${v2dir}:Innovator/Server/bin`]);
    record("deploy-code of the probe DLL v2", dep.code === 0, oneLine(dep), dep.ms);
    const probe2 = await fetchText(`${grant.url}/Server/${pageName}`);
    record("the replaced probe DLL (v2) is served", probe2.status === 200 && probe2.text.trim() === `v2-${tag}`, `GET Server/${pageName}: ${probe2.status} "${probe2.text.trim().slice(0, 60)}"`);

    // ---- 3. refusals -------------------------------------------------------------------------------------
    const evilZip = join(out, "dotdot.zip");
    writeFileSync(evilZip, buildZip([{ name: "../InnovatorServerConfig.xml", data: "<x/>" }]));
    const r1 = await cli(["deploy-code", "--lease", leaseId, evilZip]);
    record("CLI refuses a zip entry with ..", r1.code === 7, oneLine(r1), r1.ms);
    const junctionSrc = join(scratch, "junction-src");
    mkdirSync(join(junctionSrc, "Client"), { recursive: true });
    writeFileSync(join(junctionSrc, "Client", "a.txt"), "a");
    const mk = await runProcess("cmd.exe", ["/c", "mklink", "/J", await windowsPathOf(join(junctionSrc, "Client", "j")), "C:\\aras_installations\\golden"]);
    const r2 = await cli(["deploy-code", "--lease", leaseId, junctionSrc]);
    record("CLI refuses a source with a junction", mk.code === 0 && r2.code === 7, `mklink /J exit ${mk.code}; ${oneLine(r2)}`, r2.ms);
    const cfgSrc = join(out, "cfg");
    rmSync(cfgSrc, { recursive: true, force: true });
    mkdirSync(cfgSrc);
    writeFileSync(join(cfgSrc, "InnovatorServerConfig.xml"), "<Innovator/>");
    const r3 = await cli(["deploy-code", "--lease", leaseId, `${cfgSrc}:.`]);
    record("CLI refuses InnovatorServerConfig.xml without --allow-config", r3.code === 7 && /--allow-config/.test(r3.stderr), oneLine(r3), r3.ms);

    // The broker, asked directly with trees staged by hand (as a worker could, bypassing the CLI).
    const ref = { flavor: "12sp9" as const, slot: Number(grant.slot.slice(-2)) };
    const stageDir = (n: number) => join(ROOT_LOCAL, "staging", leaseId, "code", String(n));
    const stagedWin = (n: number) => `${stagingDir(leaseId)}\\code\\${n}`;
    const brokerRefuses = async (step: string, n: number, options: { subpath?: string; leaseId?: string; staged?: string } = {}) => {
      const started = Date.now();
      try {
        const r = await broker.deployCode(ref, options.staged ?? stagedWin(n), { leaseId: options.leaseId ?? leaseId, subpath: options.subpath ?? "Innovator" });
        record(step, false, `not refused: ${r.detail}`, Date.now() - started);
      } catch (err) {
        record(step, isHostError(err, "Refused") && !existsSync(stageDir(n)), `${isHostError(err) ? err.kind : "error"}: ${(err as Error).message}; staged folder ${existsSync(stageDir(n)) ? "left" : "removed"}`, Date.now() - started);
      }
    };
    mkdirSync(join(stageDir(91), "Client"), { recursive: true });
    writeFileSync(join(stageDir(91), "Client", "a.txt"), "a");
    const mk2 = await runProcess("cmd.exe", ["/c", "mklink", "/J", `${stagedWin(91)}\\Client\\secrets`, "C:\\aras_installations\\secrets"]);
    record("a junction to secrets\\ staged by hand", mk2.code === 0, `mklink /J exit ${mk2.code}`);
    await brokerRefuses("the broker refuses a staged junction", 91);
    mkdirSync(join(stageDir(92), "Client"), { recursive: true });
    writeFileSync(join(stageDir(92), "Client", "a.txt"), "a");
    linkSync(join(stageDir(92), "Client", "a.txt"), join(stageDir(92), "Client", "b.txt"));
    await brokerRefuses("the broker refuses a staged hard link", 92);
    mkdirSync(stageDir(93), { recursive: true });
    writeFileSync(join(stageDir(93), "InnovatorServerConfig.xml"), "<Innovator/>");
    await brokerRefuses("the broker refuses InnovatorServerConfig.xml without allowConfig", 93, { subpath: "" });
    mkdirSync(stageDir(94), { recursive: true });
    writeFileSync(join(stageDir(94), "a.txt"), "a");
    writeFileSync(join(stageDir(94), "deploy.json"), JSON.stringify({ delete: ["../InnovatorServerConfig.xml"] }));
    await brokerRefuses("the broker refuses a .. in deploy.json", 94);
    mkdirSync(stageDir(95), { recursive: true });
    writeFileSync(join(stageDir(95), "a.txt"), "a");
    try {
      symlinkSync(join(stageDir(95), "a.txt"), join(stageDir(95), "link.txt"));
      await brokerRefuses("the broker refuses a staged symbolic link (made from WSL)", 95);
    } catch (err) {
      record("a WSL symbolic link in staging", true, `not made on this mount (${(err as Error).message}); the junction covers it`);
      rmSync(stageDir(95), { recursive: true, force: true });
    }
    const otherLease = "0".repeat(32);
    mkdirSync(join(ROOT_LOCAL, "staging", otherLease, "code", "1"), { recursive: true });
    writeFileSync(join(ROOT_LOCAL, "staging", otherLease, "code", "1", "a.txt"), "a");
    try {
      await broker.deployCode(ref, `${stagingDir(otherLease)}\\code\\1`, { leaseId: otherLease });
      record("the broker refuses another lease's deploy into the slot", false, "not refused");
    } catch (err) {
      record("the broker refuses another lease's deploy into the slot", isHostError(err, "Refused"), (err as Error).message);
    }
    rmSync(join(ROOT_LOCAL, "staging", otherLease), { recursive: true, force: true });
    const after = await fetchText(`${grant.url}/Server/${pageName}`);
    record("the slot still serves after the refusals", after.status === 200 && after.text.trim() === `v2-${tag}`, `GET Server/${pageName}: ${after.status}`);
    for (const n of [91, 92, 93, 94, 95]) rmSync(stageDir(n), { recursive: true, force: true });

    // ---- 4. return and the reset -------------------------------------------------------------------------
    const ret = await cli(["return", leaseId, "--wait=900"], 20 * 60_000);
    held = ret.code !== 0;
    record("return --wait: the reset (its fast verify) passes", ret.code === 0, oneLine(ret), ret.ms);
    record("the client file is gone", !existsSync(slotFile(grant.slot, `Innovator/Client/${clientName}`)), clientName);
    record("the probe page and DLL are gone", !existsSync(slotFile(grant.slot, `Innovator/Server/${pageName}`)) && !existsSync(slotFile(grant.slot, "Innovator/Server/bin/ArasHouseProbe.dll")), `${pageName}, ArasHouseProbe.dll`);
    record("the golden DLL is golden's again", hashOf(slotFile(grant.slot, GOLDEN_DLL)) === sha256(goldenDll), GOLDEN_DLL);
    const gone = await fetchText(`${grant.url}/Client/${clientName}`);
    record("the client file is no longer served", gone.status === 404, `GET Client/${clientName}: ${gone.status}`);
    const health = await broker.healthCheck(ref);
    const tree = health.checks.find((c) => c.name === "tree");
    record("the broker's health check of the free slot (tree: fast verify against golden)", health.ok && tree?.ok === true, `${tree?.detail ?? "no tree check"}; ${health.detail}`, health.ms);
  } finally {
    if (held) await cli(["return", leaseId]);
  }

  // ---- 5. --atomic ------------------------------------------------------------------------------------------
  const broken = join(out, "broken-client");
  rmSync(broken, { recursive: true, force: true });
  mkdirSync(broken);
  writeFileSync(join(broken, "web.config"), "<configuration><not-closed>");
  const atomic = await cli(["get", "12sp9", "--holder", `deploy-40-atomic-${tag}`, "--json", "--atomic", "--code", `${broken}:Innovator/Client`]);
  record("get --atomic with a deploy that breaks the client: exit 10, no lease printed", atomic.code === 10 && atomic.stdout === "", oneLine(atomic), atomic.ms);
  const returnedSlot = /code deploy into (12sp9-\d\d) failed/.exec(atomic.stderr)?.[1];
  if (returnedSlot) {
    const deadline = Date.now() + 15 * 60_000;
    let state = "";
    while (Date.now() < deadline) {
      const s = JSON.parse((await cli(["status", "--json"])).stdout) as { slots: { slot: string; status: string }[] };
      state = s.slots.find((r) => r.slot === returnedSlot)?.status ?? "gone";
      if (state === "free" || state === "quarantined") break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    record("the returned slot is reset and free again", state === "free", `${returnedSlot} ${state}`);
    record("its Client web.config is golden's again", hashOf(slotFile(returnedSlot, "Innovator/Client/web.config")) === goldenClientConfig, "Innovator/Client/web.config");
  }

  rmSync(scratch, { recursive: true, force: true });
  const deny1 = await denyListPrints();
  const changed = Object.keys({ ...deny0, ...deny1 }).filter((k) => deny0[k] !== deny1[k]);
  record("deny-list after", changed.length === 0, changed.length === 0 ? `${Object.keys(deny1).length} objects unchanged` : `changed: ${changed.join(", ")}`);
  const leaked = passwords.filter((p) => outputs.some((o) => o.includes(p.reveal())) || readFileSync(logFile, "utf8").includes(p.reveal()));
  record("the lease's password is in no output but get's JSON, and not in this record", leaked.length === 0, `${passwords.length} passwords checked`);
  writeFileSync(join(out, "deploy-proof.json"), `${JSON.stringify({ tag, records }, null, 2)}\n`);
  return records;
}
