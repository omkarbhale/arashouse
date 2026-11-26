// Ticket 38: three leases at once on the laptop, the races, and the capacity limits, on the host (docs/capacity.md). Run
// natively on Windows or from WSL, as the worker, non-elevated, against the installed broker and the provisioned v1 pool (ticket 37), by
// test/host/capacity.test.ts (ARASHOUSE_TEST_E2E=1). Every step is recorded in `<out>/capacity.json` and `.log`, and the
// host's memory every 5 s in `<out>/memory.jsonl`. The same races run offline against the fake host in
// test/races.test.ts.
//
// 1. Three `get`s from three processes at once (one per flavor), then a fourth: refused at `max_active`, and queued
//    while it waits.
// 2. The three leases busy at once: each imports a scratch package and exports an item with libs-js `aras-pkg`, while
//    the host's free RAM, WSL's VM, IIS's workers, the Aras processes and SQL Server are sampled every 5 s.
// 3. All three returned at once: at most `max_resets` resets run, the rest wait dirty, and every slot ends free.
// 4. Steps 1 and 3 again for one flavor (`12sp9` x3), with a `get 12sp9` in the middle of the burst: it gets a slot
//    reset after its last lease.
// 5. With `triggerDir` (kill-broker.ps1 running elevated): the broker's process tree killed while a lease is held, and
//    again in the middle of that slot's reset; after each, `doctor --fix` makes the pool consistent, and the lease is
//    still the same one and still logs in. It runs first, right after the pool is checked at rest, so the elevated
//    script waits only minutes for its requests.
//
// Secrets: a lease's password is a Secret from the moment it is read, so `redact` replaces it in each recorded line,
// and it reaches `aras-pkg` only through `arashouse run --lease` (its environment).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { FlavorKey } from "../../src/core/flavors.js";
import { redact } from "../../src/core/redact.js";
import { Secret } from "../../src/core/secret.js";
import { BrokerHost } from "../../src/host/index.js";
import { SIDE, poolHome, runCwd, transport, wslConfigPath } from "./local.js";
import { repoRoot } from "../helpers.js";
import { ArasClient, newItemId } from "./aras-client.js";
import { denyListPrints, runProcess, slotMemory } from "./e2e-cycle.js";

const CLI = join(repoRoot, "dist/cli/index.js");
/** A `get` that should lease waits out a dip in free RAM under `min_free_ram_mb`, as the e2e cycles do. */
const RAM_WAIT = ["--wait", "900"];

export interface CapacityOptions {
  /** Where the record, the exports and the scratch packages go (outside the worktree). */
  readonly out: string;
  /** libs-js's built CLI, `dist/cli.js`. */
  readonly arasPkg: string;
  /** kill-broker.ps1's `-TriggerDir`, as a WSL path; without it step 5 is not run. */
  readonly triggerDir?: string;
  /** Import-and-export rounds per lease in step 2. Default 2. */
  readonly busyRounds?: number;
}

export interface StepRecord {
  readonly step: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

interface Grant {
  readonly slot: string;
  readonly flavor: FlavorKey;
  readonly engine: string;
  readonly url: string;
  readonly database: string;
  readonly lease_id: string;
  readonly password: Secret;
}

interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

interface Row {
  readonly slot: string;
  readonly status: string;
  readonly holder: string | null;
}

interface StatusReport {
  readonly slots: Row[];
  readonly queue: { holder: string }[];
}

/** One reading of the host's memory, in MB (working sets), with the phase it was taken in. */
export interface MemorySample {
  readonly at: string;
  readonly phase: string;
  readonly freeMb: number;
  readonly wslMb: number;
  readonly w3wpMb: number;
  readonly w3wp: number;
  readonly arasMb: number;
  readonly aras: number;
  readonly dotnetMb: number;
  readonly sqlMb: number;
}

interface LogEvent {
  readonly ts: string;
  readonly event: string;
  readonly slot?: string;
  readonly from?: string | null;
  readonly to?: string;
  readonly lease?: string;
  readonly holder?: string;
}

export class CapacityFailed extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The host's memory every 5 s from one long-lived Windows PowerShell (no 0.5 s start per reading): free physical
 * memory, and the summed working set of WSL's VM (`vmmemWSL`), IIS's workers (`w3wp.exe`), the 14.x Aras processes
 * (`Aras.*.exe`), `dotnet.exe` (12sp9's OAuth server, and any other) and SQL Server. Read only.
 */
const SAMPLER = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "while ($true) {",
  "  $os = Get-CimInstance Win32_OperatingSystem",
  "  $p = @(Get-CimInstance Win32_Process -Filter \"Name='vmmemWSL' OR Name='vmmem' OR Name='w3wp.exe' OR Name='sqlservr.exe' OR Name='dotnet.exe' OR Name LIKE 'Aras.%'\")",
  "  $mb = { param($like) [math]::Round((($p | Where-Object { $_.Name -like $like } | Measure-Object WorkingSetSize -Sum).Sum) / 1MB) }",
  "  $n = { param($like) @($p | Where-Object { $_.Name -like $like }).Count }",
  "  '{{\"freeMb\":{0},\"wslMb\":{1},\"w3wpMb\":{2},\"w3wp\":{3},\"arasMb\":{4},\"aras\":{5},\"dotnetMb\":{6},\"sqlMb\":{7}}}' -f [math]::Round($os.FreePhysicalMemory / 1KB), (& $mb 'vmmem*'), (& $mb 'w3wp.exe'), (& $n 'w3wp.exe'), (& $mb 'Aras.*'), (& $n 'Aras.*'), (& $mb 'dotnet.exe'), (& $mb 'sqlservr.exe')",
  "  [Console]::Out.Flush()",
  "  Start-Sleep -Seconds 5",
  "}",
].join("\n");

function startSampler(file: string, phase: () => string): { stop: () => MemorySample[] } {
  const samples: MemorySample[] = [];
  // As -EncodedCommand: a loop read from stdin (`-Command -`) is never run, as PowerShell waits for a blank line.
  const encoded = Buffer.from(SAMPLER, "utf16le").toString("base64");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { cwd: runCwd(), stdio: ["ignore", "pipe", "ignore"] });
  let buffer = "";
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      const sample = { at: new Date().toISOString(), phase: phase(), ...(JSON.parse(line) as Omit<MemorySample, "at" | "phase">) };
      samples.push(sample);
      appendFileSync(file, `${JSON.stringify(sample)}\n`);
    }
  });
  return {
    stop: () => {
      child.kill("SIGKILL");
      return samples;
    },
  };
}

/** The lowest free RAM and the highest of each process group, over the samples of the given phases. */
export function memorySummary(samples: readonly MemorySample[], phases?: readonly string[]): string {
  const these = phases ? samples.filter((s) => phases.includes(s.phase)) : samples;
  if (these.length === 0) return "no samples";
  const min = (k: keyof MemorySample) => Math.min(...these.map((s) => s[k] as number));
  const max = (k: keyof MemorySample) => Math.max(...these.map((s) => s[k] as number));
  return (
    `${these.length} samples: free RAM ${min("freeMb")} to ${max("freeMb")} MB; WSL VM up to ${max("wslMb")} MB; ` +
    `w3wp.exe up to ${max("w3wpMb")} MB (${max("w3wp")} processes); Aras.*.exe up to ${max("arasMb")} MB (${max("aras")}); ` +
    `dotnet.exe up to ${max("dotnetMb")} MB; SQL Server ${min("sqlMb")} to ${max("sqlMb")} MB`
  );
}

/** Replays the transitions in commit order: the most resets running at once, and whether a slot waited dirty meanwhile. */
export function resetConcurrency(log: readonly LogEvent[]): { peak: number; dirtyAtPeak: boolean } {
  const now = new Map<string, string>();
  let peak = 0;
  let dirtyAtPeak = false;
  for (const e of log) {
    if (e.event !== "transition" || !e.slot || !e.to) continue;
    now.set(e.slot, e.to);
    const running = [...now.values()].filter((s) => s === "resetting").length;
    const dirty = [...now.values()].some((s) => s === "dirty");
    if (running > peak) [peak, dirtyAtPeak] = [running, dirty];
    else if (running === peak && dirty) dirtyAtPeak = true;
  }
  return { peak, dirtyAtPeak };
}

export async function runCapacity(options: CapacityOptions): Promise<StepRecord[]> {
  const { out } = options;
  const home = poolHome();
  const tag = randomBytes(4).toString("hex");
  const records: StepRecord[] = [];
  const seenPasswords: Secret[] = [];
  const outputs: string[] = [];
  mkdirSync(out, { recursive: true });
  const logFile = join(out, "capacity.log");
  const memoryFile = join(out, "memory.jsonl");
  writeFileSync(logFile, `capacity run, tag ${tag}, started ${new Date().toISOString()}\n`);
  writeFileSync(memoryFile, "");
  let phase = "before";

  const record = (step: string, ok: boolean, ms: number, detail: string) => {
    const line = redact(detail);
    records.push({ step, ok, ms, detail: line });
    const text = `${ok ? "ok  " : "FAIL"} ${step} (${(ms / 1000).toFixed(1)} s): ${line}`;
    appendFileSync(logFile, `${text}\n`);
    console.log(text);
  };
  const check = (step: string, ok: boolean, detail: string, ms = 0) => record(step, ok, ms, detail);
  const must = (step: string, ok: boolean, detail: string, ms = 0) => {
    record(step, ok, ms, detail);
    if (!ok) throw new CapacityFailed(`${step}: ${redact(detail)}`);
  };

  /** The leases the run holds: given back if it stops early, so a failed run leaves no lease behind. */
  const held = new Set<string>();
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
        if (args[0] === "return" && code === 0 && args[1]) held.delete(args[1]);
        // `get --json` prints the password once on stdout; everything else is checked for it at the end.
        outputs.push(args[0] === "get" && args.includes("--json") ? stderr : `${stdout}\n${stderr}`);
        resolve({ code, stdout, stderr, ms: Date.now() - started });
      });
    });
  const oneLine = (run: CliRun) => redact(`${run.stdout} ${run.stderr}`.replace(/\s+/g, " ").trim()).slice(0, 300);
  const get = async (flavor: FlavorKey, holder: string, extra: string[] = RAM_WAIT): Promise<{ run: CliRun; grant?: Grant }> => {
    const run = await cli(["get", flavor, "--holder", holder, "--json", ...extra]);
    if (run.code !== 0) return { run };
    const json = JSON.parse(run.stdout) as Omit<Grant, "password"> & { password: string };
    const password = Secret.of(json.password, "lease-password");
    seenPasswords.push(password);
    held.add(json.lease_id);
    return { run, grant: { slot: json.slot, flavor: json.flavor, engine: json.engine, url: json.url, database: json.database, lease_id: json.lease_id, password } };
  };
  const status = async (): Promise<StatusReport> => {
    const run = await cli(["status", "--json"]);
    if (run.code !== 0) throw new CapacityFailed(`status --json exited ${run.code}: ${oneLine(run)}`);
    return JSON.parse(run.stdout) as StatusReport;
  };
  /** Polls `status` until `done` holds for its rows, or the deadline passes. */
  const waitFor = async (done: (rows: Row[]) => boolean, timeoutMs: number): Promise<{ ok: boolean; rows: Row[]; ms: number }> => {
    const started = Date.now();
    for (;;) {
      const rows = (await status()).slots;
      if (done(rows)) return { ok: true, rows, ms: Date.now() - started };
      if (Date.now() - started > timeoutMs) return { ok: false, rows, ms: Date.now() - started };
      await sleep(2000);
    }
  };
  const describeRows = (rows: Row[]) => rows.map((r) => `${r.slot} ${r.status}${r.holder ? ` (${r.holder})` : ""}`).join(", ");
  const allFree = (rows: Row[]) => rows.every((r) => r.status === "free");
  const eventsSince = (since: string): LogEvent[] =>
    readFileSync(join(home, "events.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LogEvent)
      .filter((e) => e.ts >= since);
  const leaseOf = (slot: string): { lease_id?: string; holder?: string; status?: string } => {
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { slots: { id: string; status: string; lease?: { lease_id: string; holder: string } }[] };
    const s = state.slots.find((x) => x.id === slot);
    return { status: s?.status, lease_id: s?.lease?.lease_id, holder: s?.lease?.holder };
  };
  const logsIn = async (g: Grant): Promise<string | undefined> => {
    const login = await new ArasClient(g.url, g.database).login("root", g.password);
    return login.ok ? undefined : login.detail;
  };

  /** Three leases at once, one per entry of `flavors`, then a fourth of `fourth`: refused, and queued while it waits. */
  const raceOfThree = async (name: string, flavors: readonly FlavorKey[], fourth: FlavorKey, fourthReason: string): Promise<Grant[]> => {
    phase = `race-${name}`;
    const t = Date.now();
    const runs = await Promise.all(flavors.map((f, i) => get(f, `cap-${name}-${i + 1}`)));
    const grants = runs.flatMap((r) => (r.grant ? [r.grant] : []));
    must(
      `${name}.three gets at once`,
      grants.length === 3 && new Set(grants.map((g) => g.slot)).size === 3 && new Set(grants.map((g) => g.lease_id)).size === 3,
      runs.map((r) => (r.grant ? `${r.grant.slot} in ${(r.run.ms / 1000).toFixed(1)} s` : `exit ${r.run.code}: ${oneLine(r.run)}`)).join("; "),
      Date.now() - t,
    );
    const refused = await get(fourth, `cap-${name}-4`, ["--wait", "0"]);
    check(`${name}.a fourth get --wait 0 exits 3`, refused.run.code === 3 && refused.run.stderr.includes(fourthReason), `exit ${refused.run.code}: ${oneLine(refused.run)}`, refused.run.ms);
    if (refused.grant) await cli(["return", refused.grant.lease_id, "--quiet"]);
    const waiting = get(fourth, `cap-${name}-4w`, ["--wait", "20"]);
    let queued = false;
    for (let i = 0; i < 8 && !queued; i++) {
      await sleep(1500);
      queued = (await status()).queue.some((w) => w.holder === `cap-${name}-4w`);
    }
    const waited = await waiting;
    if (waited.grant) await cli(["return", waited.grant.lease_id, "--quiet"]);
    check(`${name}.a fourth get --wait 20 queues, then exits 3`, queued && waited.run.code === 3, `in the queue: ${queued}; exit ${waited.run.code} after ${(waited.run.ms / 1000).toFixed(1)} s: ${oneLine(waited.run)}`, waited.run.ms);
    return grants;
  };

  /** Returns every grant at once (and, with `during`, a get of that flavor a second later); every slot must end free. */
  const burst = async (name: string, grants: readonly Grant[], during?: FlavorKey): Promise<void> => {
    phase = `burst-${name}`;
    const since = new Date().toISOString();
    const t = Date.now();
    const [returns, mid] = await Promise.all([
      Promise.all(grants.map((g) => cli(["return", g.lease_id, "--quiet"]))),
      during ? sleep(1000).then(() => get(during, `cap-${name}-during`)) : Promise.resolve(undefined),
    ]);
    check(`${name}.three returns at once`, returns.every((r) => r.code === 0), returns.map((r) => `exit ${r.code} in ${(r.ms / 1000).toFixed(2)} s`).join("; "), Date.now() - t);
    if (mid) {
      must(`${name}.a get during the burst`, mid.grant !== undefined, mid.grant ? `${mid.grant.slot} in ${(mid.run.ms / 1000).toFixed(1)} s` : oneLine(mid.run), mid.run.ms);
      const g = mid.grant!;
      const mine = eventsSince(since).filter((e) => e.event === "transition" && e.slot === g.slot).map((e) => `${e.from}->${e.to}`);
      const ended = mine.indexOf("leased->dirty");
      check(`${name}.its slot was reset after its last lease`, ended >= 0 && mine.lastIndexOf("resetting->free") > ended && mine.at(-1) === "free->leased", mine.join(", "));
      const login = await logsIn(g);
      check(`${name}.it logs in with its lease's password`, login === undefined, login ?? "token issued");
    }
    const settled = await waitFor((rows) => rows.every((r) => r.status === "free" || (mid?.grant !== undefined && r.holder === `cap-${name}-during`)), 20 * 60_000);
    const { peak, dirtyAtPeak } = resetConcurrency(eventsSince(since));
    check(`${name}.at most max_resets resets at once`, settled.ok && peak <= DEFAULT_CONFIG.max_resets, `peak ${peak} resetting (max_resets ${DEFAULT_CONFIG.max_resets}); a slot waited dirty at the peak: ${dirtyAtPeak}; ${describeRows(settled.rows)}`, Date.now() - t);
    if (mid?.grant) {
      await cli(["return", mid.grant.lease_id, "--quiet"]);
      const free = await waitFor(allFree, 10 * 60_000);
      check(`${name}.every slot free after the burst`, free.ok, describeRows(free.rows), Date.now() - t);
    }
  };

  /** Each lease imports a scratch package and exports an item, `rounds` times, all three at once. */
  const busy = async (grants: readonly Grant[], rounds: number): Promise<void> => {
    phase = "busy";
    const t = Date.now();
    await Promise.all(
      grants.map(async (g) => {
        const nn = g.slot.slice(g.slot.lastIndexOf("-") + 1);
        const aras = new ArasClient(g.url, g.database);
        const login = await aras.login("root", g.password);
        if (!login.ok) return check(`busy.${g.slot} logs in`, false, login.detail);
        const it = await aras.apply(login.token, `<Item type="ItemType" action="get" select="id"><name>Language</name></Item>`);
        const langTypeId = /<Item[^>]*\bid="([0-9A-F]{32})"/.exec(it.body)?.[1];
        for (let round = 1; round <= rounds; round++) {
          const pkgName = `LIBSJS-SCRATCH-CAP-${tag.toUpperCase()}-${nn}${round}`;
          const varName = `AH-CAP-${tag}-${g.flavor}-${nn}-${round}`;
          const pkgDir = join(out, `${g.slot}-package-${round}`);
          rmSync(pkgDir, { recursive: true, force: true });
          mkdirSync(join(pkgDir, pkgName, "Import", "Variable"), { recursive: true });
          writeFileSync(join(pkgDir, "imports.mf"), `<imports>\n  <package name="${pkgName}" path="${pkgName}\\Import" />\n</imports>\n`);
          writeFileSync(join(pkgDir, pkgName, "Import", "Variable", `${varName}.xml`), `<AML>\n <Item type="Variable" id="${newItemId()}" action="add">\n  <default_value>${tag}</default_value>\n  <name>${varName}</name>\n </Item>\n</AML>\n`);
          const imp = await cli(["run", "--lease", g.lease_id, "--", "node", options.arasPkg, "import", "--engine", g.engine, "--log", join(out, `${g.slot}-import-${round}.log`), join(pkgDir, "imports.mf")]);
          check(`busy.${g.slot} aras-pkg import, round ${round}`, imp.code === 0, `exit ${imp.code}: ${oneLine(imp).slice(0, 160)}`, imp.ms);
          const exportDir = join(out, `${g.slot}-export-${round}`);
          rmSync(exportDir, { recursive: true, force: true });
          const exp = await cli(["run", "--lease", g.lease_id, "--", "node", options.arasPkg, "export", "--engine", g.engine, "--log", join(out, `${g.slot}-export-${round}.log`), exportDir, `ItemType:${langTypeId ?? "missing"}`]);
          check(`busy.${g.slot} aras-pkg export, round ${round}`, exp.code === 0 && existsSync(join(exportDir, "imports.mf")), `exit ${exp.code}: ${oneLine(exp).slice(0, 160)}`, exp.ms);
        }
        return undefined;
      }),
    );
    for (const g of grants) {
      const nn = g.slot.slice(g.slot.lastIndexOf("-") + 1);
      check(`busy.${g.slot} memory after the work`, true, await slotMemory(g.flavor, nn));
    }
    record("busy.three leases at work", true, Date.now() - t, `${rounds} import and export rounds each`);
  };

  /** Asks kill-broker.ps1 for kill `n` and waits for the broker to be back (its `.back` file, then a ping). */
  const killBroker = async (n: number): Promise<{ ok: boolean; detail: string; ms: number }> => {
    const dir = options.triggerDir!;
    const t = Date.now();
    writeFileSync(join(dir, `kill-${n}.request`), `${new Date().toISOString()}\n`);
    const deadline = Date.now() + 4 * 60_000;
    while (!existsSync(join(dir, `kill-${n}.back`)) && Date.now() < deadline) await sleep(500);
    const done = existsSync(join(dir, `kill-${n}.done`)) ? readFileSync(join(dir, `kill-${n}.done`), "utf8").trim() : "no .done";
    const back = existsSync(join(dir, `kill-${n}.back`)) ? readFileSync(join(dir, `kill-${n}.back`), "utf8").trim() : "no .back";
    let pinged = false;
    const host = new BrokerHost(transport());
    while (!pinged && Date.now() < deadline) {
      pinged = await host.ping().then((r) => r.ok, () => false);
      if (!pinged) await sleep(2000);
    }
    return { ok: pinged && !back.startsWith("failed"), detail: `killed: ${done}; back: ${back}; ping ${pinged ? "answered" : "did not answer"}`, ms: Date.now() - t };
  };

  const sampler = startSampler(memoryFile, () => phase);
  try {
    // ---- 0. the pool at rest -------------------------------------------------------------------------------------
    const denyBefore = await denyListPrints();
    check("0.deny-list before", Object.keys(denyBefore).length > 0, `${Object.keys(denyBefore).length} objects fingerprinted (names and hashes only)`);
    const profile = (await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$env:USERPROFILE"])).stdout.trim();
    const wslconfig = wslConfigPath(profile);
    const capLines = existsSync(wslconfig) ? readFileSync(wslconfig, "utf8").split(/\r?\n/).filter((l) => /^\s*(memory|autoMemoryReclaim)\s*=/.test(l)).map((l) => l.trim()) : [];
    check("0.WSL's memory", true, `.wslconfig ${existsSync(wslconfig) ? `has ${capLines.join(", ") || "no memory line"}` : "absent"}; ${SIDE === "wsl" ? `the VM sees ${Math.round(totalmem() / 1024 / 1024)} MB` : `natively; the machine has ${Math.round(totalmem() / 1024 / 1024)} MB`}`);
    const rest = await status();
    must("0.every slot free", rest.slots.length === 7 && allFree(rest.slots), describeRows(rest.slots));
    phase = "idle";
    await sleep(30_000);

    // ---- 5 (first, so kill-broker.ps1 waits only minutes). the broker killed during a lease and during a reset ------
    if (options.triggerDir) {
      phase = "kill";
      const { grant: k, run } = await get("23", "cap-kill");
      must("5.get 23 for the kills", k !== undefined, k ? `${k.slot}` : oneLine(run), run.ms);
      const kept = k!;
      const first = await killBroker(1);
      must("5.the broker's tree killed during the lease, and back", first.ok, first.detail, first.ms);
      const fix1 = await cli(["doctor", "--fix", "--yes"]);
      check("5.doctor --fix after the kill during a lease", fix1.code === 0, oneLine(fix1), fix1.ms);
      const after = leaseOf(kept.slot);
      check("5.the lease is still the same one", after.status === "leased" && after.lease_id === kept.lease_id && after.holder === "cap-kill", `${kept.slot} ${after.status}, lease ${after.lease_id === kept.lease_id ? "unchanged" : "changed"}, holder ${after.holder}`);
      const login = await logsIn(kept);
      check("5.it still logs in with its password", login === undefined, login ?? "token issued");

      const since = new Date().toISOString();
      const ret = await cli(["return", kept.lease_id, "--quiet"]);
      check("5.return", ret.code === 0, oneLine(ret), ret.ms);
      const resetting = await waitFor((rows) => rows.find((r) => r.slot === kept.slot)?.status === "resetting", 60_000);
      await sleep(8_000);
      const second = await killBroker(2);
      must("5.the broker's tree killed in the middle of the reset, and back", resetting.ok && second.ok, `${resetting.ok ? "it was resetting" : "it never showed resetting"}; ${second.detail}`, second.ms);
      const seen = eventsSince(since).filter((e) => e.event === "transition" && e.slot === kept.slot).map((e) => `${e.from}->${e.to}`);
      check("5.what the reset worker made of it", true, `${seen.join(", ")}; now ${leaseOf(kept.slot).status}`);
      const fix2 = await cli(["doctor", "--fix", "--yes"]);
      check("5.doctor --fix after the kill during a reset", true, `exit ${fix2.code}: ${oneLine(fix2)}`, fix2.ms);
      const free = await waitFor(allFree, 15 * 60_000);
      check("5.every slot free again", free.ok, describeRows(free.rows), free.ms);
    }

    // ---- 1 to 3. three flavors at once -----------------------------------------------------------------------------
    const mixed = await raceOfThree("mixed", ["12sp9", "23", "35"], "12sp9", `max_active ${DEFAULT_CONFIG.max_active} reached`);
    await busy(mixed, options.busyRounds ?? 2);
    phase = "held";
    await sleep(15_000);
    await burst("mixed", mixed);

    // ---- 4. one flavor at once, with a get of that flavor in the middle of the burst --------------------------------
    const same = await raceOfThree("same", ["12sp9", "12sp9", "12sp9"], "12sp9", "no 12sp9 slot is free");
    await burst("same", same, "12sp9");

    // ---- 6. the pool at rest again ---------------------------------------------------------------------------------
    phase = "after";
    const doctor = await cli(["doctor"]);
    check("6.doctor", doctor.code === 0, oneLine(doctor), doctor.ms);
    const denyAfter = await denyListPrints();
    check("6.deny-list unchanged", JSON.stringify(denyAfter) === JSON.stringify(denyBefore), `${Object.keys(denyAfter).length} objects, ${JSON.stringify(denyAfter) === JSON.stringify(denyBefore) ? "the same" : "CHANGED"}`);
  } catch (err) {
    if (!(err instanceof CapacityFailed)) record("error", false, 0, err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    for (const leaseId of held) await cli(["return", leaseId, "--quiet"]);
    const samples = sampler.stop();
    for (const p of ["idle", "race-mixed", "busy", "held", "burst-mixed", "race-same", "burst-same", "kill", "after"]) record(`memory.${p}`, true, 0, memorySummary(samples, [p]));
    const minFree = samples.length ? Math.min(...samples.map((s) => s.freeMb)) : NaN;
    record("memory.whole run", samples.length > 0, 0, `${memorySummary(samples)}; min_free_ram_mb ${DEFAULT_CONFIG.min_free_ram_mb}, lowest free ${minFree} MB`);
    const leaked = outputs.some((o) => seenPasswords.some((p) => o.includes(p.reveal())));
    record("secrets.no lease password in any output but get --json's", !leaked, 0, `${outputs.length} outputs checked against ${seenPasswords.length} passwords`);
    writeFileSync(join(out, "capacity.json"), `${JSON.stringify(records, null, 2)}\n`);
  }
  return records;
}
