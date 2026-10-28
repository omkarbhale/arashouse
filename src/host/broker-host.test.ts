import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker, inProcessTransport } from "../broker/broker.js";
import { mappedRoot, type MappedRoot } from "../broker/mapped-fs.fixture.js";
import type { BrokerRequest } from "../broker/protocol.js";
import { registerBaselineVerbs } from "../broker/baseline-verbs.js";
import { SlotLocks, registerSlotVerbs } from "../broker/provision.js";
import { registerHealthVerb } from "../broker/health.js";
import { registerResetVerbs } from "../broker/reset-tree.js";
import { FAKE_GOLDEN_HASH, FakeSlotSystem } from "../broker/slot-system.fixture.js";
import { registerCoreVerbs, type BrokerSystem } from "../broker/verbs.js";
import { buildManifest, writeManifestOnce } from "../broker/manifest-fs.js";
import { FakeAras } from "../../test/fake-aras.js";
import { makeSampleTree } from "../../test/sample-tree.js";
import { slotRootSecretName, stampFile } from "../core/names.js";
import { Secret } from "../core/secret.js";
import { MemorySecretStore } from "../core/secret-store.js";
import { BrokerHost } from "./broker-host.js";
import { INTEROP_RETRY_DELAY_MS, INTEROP_START_ATTEMPTS, interopTransport, isInteropStartFailure, type BrokerTransport } from "./broker-transport.js";
import { FakeClock } from "./clock.js";
import { HOST_METHODS, type HostDriver } from "./driver.js";
import { HostError } from "./errors.js";

const LEASE_REF = "lease-1";

const ROOT = "C:\\aras_installations";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const s1 = { flavor: "12sp9", slot: 1 } as const;

let root: MappedRoot;
let broker: Broker;
let transport: BrokerTransport & { requests: BrokerRequest[] };
let host: BrokerHost;
let slots: FakeSlotSystem;

beforeEach(() => {
  root = mappedRoot(ROOT);
  const system: BrokerSystem = {
    fs: root.fs,
    brokerVersion: "0.1.0",
    os: () => "Windows_NT 10.0.26100",
    freeRamBytes: () => 8 * 1024 * 1024 * 1024,
    sqlLogin: async () => ({ login: "NT SERVICE\\ArasHouseBroker", sysadmin: false, dbcreator: false, procedures: 5 }),
  };
  slots = new FakeSlotSystem(ROOT);
  const locks = new SlotLocks();
  broker = registerHealthVerb(
    registerResetVerbs(
      registerSlotVerbs(
        registerBaselineVerbs(registerCoreVerbs(new Broker({ root: ROOT, isReparsePoint: root.fs.isReparsePoint, realPath: root.fs.realPath }), system), system),
        slots,
        locks,
      ),
      slots,
      locks,
    ),
    slots,
    locks,
  );
  const inner = inProcessTransport(broker);
  const requests: BrokerRequest[] = [];
  transport = {
    requests,
    call: (request) => {
      requests.push(request);
      return inner.call(request);
    },
  };
  host = new BrokerHost(transport);
});

afterEach(() => root.cleanup());

function answering(response: unknown): BrokerHost {
  return new BrokerHost({ call: async (request) => (typeof response === "function" ? response(request) : response) });
}

async function rejection(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

describe("BrokerHost against an in-process broker", () => {
  it("ping and hostInfo work", async () => {
    expect(await host.ping()).toMatchObject({ ok: true, detail: "arashouse-broker 0.1.0" });
    const { info } = await host.hostInfo();
    expect(info).toMatchObject({
      os: "Windows_NT 10.0.26100",
      freeRamMb: 8192,
      brokerVersion: "0.1.0",
      sqlReachable: true,
      sqlLogin: { login: "NT SERVICE\\ArasHouseBroker", sysadmin: false, dbcreator: false, procedures: 5 },
    });
  });

  it("measures ms on its own clock", async () => {
    const clock = new FakeClock();
    const slow = new BrokerHost(
      {
        call: async (request) => {
          clock.advance(42);
          return { id: request.id, ok: true, result: { ok: true, detail: "pong" } };
        },
      },
      { clock },
    );
    expect(await slow.ping()).toEqual({ ok: true, ms: 42, detail: "pong" });
  });

  it("readStamp and listSlots read the slot folders", async () => {
    root.slot(s1);
    root.slot({ flavor: "23", slot: 2 }, null);
    expect((await host.readStamp(s1)).stamp).toMatchObject({ slotId: "12sp9-01", goldenHash: "g1" });
    expect((await host.readStamp({ flavor: "23", slot: 2 })).stamp).toBeNull();
    expect((await host.listSlots()).slots).toEqual([
      { slot: s1, stamp: expect.objectContaining({ slotId: "12sp9-01" }) },
      { slot: { flavor: "23", slot: 2 }, stamp: null },
    ]);
  });

  it("a broker error keeps its kind", async () => {
    expect(await rejection(host.readStamp(s1))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not provisioned" });
  });

  it("guards on the WSL side before anything is sent", async () => {
    const err = await rejection(host.readStamp({ flavor: "OLM_Local" as never, slot: 1 }));
    expect(err.kind).toBe("Refused");
    expect(transport.requests).toEqual([]);
  });

  it("refuses a bad slot, flavor or staged path before anything reaches the broker", async () => {
    expect((await rejection(host.startSlot({ flavor: "prod" as never, slot: 1 }, { agent: false }))).kind).toBe("Refused");
    expect((await rejection(host.baselineBuild("olm" as never))).kind).toBe("Refused");
    // A staged path outside the lease's staging folder is refused on this side, as FakeHost refuses it.
    for (const path of [`${ROOT}\\staging`, `${ROOT}\\golden\\12sp9\\db\\ootb.bak`, "C:\\Program Files (x86)\\Aras\\Innovator\\Server"]) {
      expect((await rejection(host.deployCode(s1, path, { leaseId: "a".repeat(32) }))).kind).toBe("Refused");
      expect((await rejection(host.restoreDatabase(s1, path))).kind).toBe("Refused");
      expect((await rejection(host.backupDatabase(s1, path))).kind).toBe("Refused");
    }
    expect(transport.requests).toEqual([]);
  });

  it("never builds a baseline through the broker: the build is an elevated session's", async () => {
    const err = await rejection(host.baselineBuild("12sp9"));
    expect(err.kind).toBe("Refused");
    expect(err.message).toContain("arashouse baseline build 12sp9");
    expect(transport.requests).toEqual([]);
  });

  it("provisions and destroys a slot through the broker's verbs, guarded on both sides", async () => {
    const made = await host.provisionSlot(s1);
    expect(made).toMatchObject({ ok: true, detail: expect.stringMatching(/^provisioned 12sp9-01 from golden /) });
    expect(slots.objects.has(`${ROOT}\\slots\\12sp9\\01`)).toBe(true);
    expect(await rejection(host.provisionSlot(s1))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is already provisioned" });
    expect(await host.destroySlot(s1)).toMatchObject({ ok: true, detail: expect.stringMatching(/^destroyed 12sp9-01 in /) });
    expect(await slots.leftovers(s1)).toEqual([]);
    expect(transport.requests.map((r) => [r.verb, r.slot, r.args])).toEqual([
      ["provisionSlot", s1, undefined],
      ["provisionSlot", s1, undefined],
      ["destroySlot", s1, undefined],
    ]);
    expect((await rejection(host.provisionSlot({ flavor: "OLM_Local" as never, slot: 1 }))).kind).toBe("Refused");
    expect((await rejection(host.destroySlot({ flavor: "12sp9", slot: 100 }))).kind).toBe("Refused");
    expect(transport.requests).toHaveLength(3);
  });

  it("sets the lease's credentials from the handle, the password on the request line only", async () => {
    await host.provisionSlot(s1);
    const aras = new FakeAras();
    slots.aras = aras;
    const free = ["free", "Root", "Pw", "x9"].join("-");
    const leasePassword = ["lease", "Pw", "Vb3nM8kL2qXs"].join("_");
    for (const login of ["root", "admin"]) aras.set("ah-12sp9-01", login, free);
    await slots.secrets.put(slotRootSecretName(s1), Secret.of(free, "aras-login"));
    const leases = new MemorySecretStore();
    await leases.put(LEASE_REF, Secret.of(leasePassword, "lease-password"));
    const leased = new BrokerHost(transport, { secrets: leases });

    const set = await leased.setLeaseCredentials(s1, { secretRef: LEASE_REF });
    expect(set).toMatchObject({ ok: true, detail: expect.stringMatching(/^lease credentials set for admin and root of 12sp9-01/) });
    expect(aras.logsIn("ah-12sp9-01", "root", leasePassword)).toBe(true);
    expect(aras.logsIn("ah-12sp9-01", "admin", leasePassword)).toBe(true);
    expect(transport.requests.at(-1)).toMatchObject({ verb: "setLeaseCredentials", slot: s1, args: { password: leasePassword } });
    expect(set.detail).not.toContain(leasePassword);

    // Refused on this side, with nothing sent: no handle, a handle with nothing behind it, no store at all.
    const sent = transport.requests.length;
    expect((await rejection(leased.setLeaseCredentials(s1, { secretRef: "" }))).message).toBe("a secret handle is required");
    const unknown = { secretRef: `${LEASE_REF}0` };
    expect((await rejection(leased.setLeaseCredentials(s1, unknown))).message).toBe("no lease password is stored as lease-10");
    expect((await rejection(host.setLeaseCredentials(s1, { secretRef: LEASE_REF }))).kind).toBe("Refused");
    expect((await rejection(leased.setLeaseCredentials({ flavor: "OLM_Local" as never, slot: 1 }, { secretRef: LEASE_REF }))).kind).toBe("Refused");
    expect(transport.requests).toHaveLength(sent);
  });

  it("starts and stops a slot through the broker's verbs, the agent only when asked, guarded on both sides", async () => {
    expect(await rejection(host.startSlot(s1, { agent: false }))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not provisioned" });
    await host.provisionSlot(s1);
    slots.agentInstalled = true;
    const plain = await host.startSlot(s1, { agent: false });
    expect(plain).toMatchObject({ ok: true, detail: expect.stringMatching(/^started 12sp9-01 in .*agent not started; warm Client\/ 200/) });
    expect(slots.agentRunning.has("12sp9-01")).toBe(false);
    const withAgent = await host.startSlot(s1, { agent: true });
    expect(withAgent.detail).toContain("agent ArasHouseAgent_12sp9_01 running on port 8801");
    expect(slots.agentRunning.has("12sp9-01")).toBe(true);
    expect(await host.stopSlot(s1)).toMatchObject({ ok: true, detail: expect.stringMatching(/^stopped 12sp9-01 in .* \(7 pools; agent stopped\)$/) });
    expect(slots.agentRunning.has("12sp9-01")).toBe(false);
    expect(slots.running.has("12sp9-01")).toBe(false);
    expect(transport.requests.slice(2).map((r) => [r.verb, r.slot, r.args])).toEqual([
      ["startSlot", s1, { agent: false }],
      ["startSlot", s1, { agent: true }],
      ["stopSlot", s1, undefined],
    ]);
    expect((await rejection(host.stopSlot({ flavor: "OLM_Local" as never, slot: 1 }))).kind).toBe("Refused");
    expect((await rejection(host.startSlot({ flavor: "12sp9", slot: 100 }, { agent: true }))).kind).toBe("Refused");
    expect(transport.requests).toHaveLength(5);
  });

  it("quiesces, resets the tree to the golden hash and writes a stamp through the broker's verbs, guarded on both sides", async () => {
    await host.provisionSlot(s1);
    const hash = slots.manifest("12sp9").manifestHash;
    expect(await rejection(host.resetTree(s1, { flavor: "12sp9", hash }))).toMatchObject({ kind: "Refused", message: expect.stringContaining("is not quiesced") });
    expect(await host.quiesce(s1)).toMatchObject({ ok: true, detail: expect.stringMatching(/^quiesced 12sp9-01 in /) });
    expect(await host.resetTree(s1, { flavor: "12sp9", hash })).toMatchObject({ ok: true, detail: expect.stringMatching(/^reset the tree of 12sp9-01 to golden /) });
    // The slot verbs act through the in-memory slot system here, so the stamp is read from it.
    const stampPath = `${ROOT}\\slots\\12sp9\\01\\.arashouse-slot.json`;
    const stamp = JSON.parse(slots.text(stampPath)!);
    expect(stamp).toMatchObject({ goldenHash: hash, leaseId: null });
    expect(await host.writeStamp(s1, { ...stamp, leaseId: "0123abcd" })).toMatchObject({ ok: true });
    expect(JSON.parse(slots.text(stampPath)!)).toEqual({ ...stamp, leaseId: "0123abcd" });
    expect(transport.requests.slice(1).map((r) => [r.verb, r.args])).toEqual([
      ["resetTree", { hash }],
      ["quiesce", undefined],
      ["resetTree", { hash }],
      ["writeStamp", { stamp: { ...stamp, leaseId: "0123abcd" } }],
    ]);
    const sent = transport.requests.length;
    expect((await rejection(host.resetTree(s1, { flavor: "23", hash }))).kind).toBe("Refused");
    expect((await rejection(host.quiesce({ flavor: "OLM_Local" as never, slot: 1 }))).kind).toBe("Refused");
    expect((await rejection(host.writeStamp({ flavor: "12sp9", slot: 0 }, stamp))).kind).toBe("Refused");
    expect(transport.requests).toHaveLength(sent);
  });

  it("resets a slot's database through the broker's resetDatabase verb, guarded on both sides", async () => {
    await host.provisionSlot(s1);
    const ootb = `${ROOT}\\golden\\12sp9\\db\\ootb.bak`;
    const done = await host.resetDatabase(s1, { flavor: "12sp9", file: ootb, hash: FAKE_GOLDEN_HASH });
    expect(done).toMatchObject({ ok: true, detail: expect.stringMatching(/^database of 12sp9-01 restored from golden 999999999999 /) });
    expect(slots.databaseMarkers.get("arashouse_12sp9_01")?.goldenHash).toBe(FAKE_GOLDEN_HASH);
    expect(transport.requests.at(-1)).toMatchObject({ verb: "resetDatabase", slot: s1, args: { file: ootb, hash: FAKE_GOLDEN_HASH } });
    // The broker answers for the golden's other files; a path outside it, or another flavor's backup, never leaves WSL.
    expect(await rejection(host.resetDatabase(s1, { flavor: "12sp9", file: `${ROOT}\\golden\\12sp9\\db\\Core120.bak`, hash: FAKE_GOLDEN_HASH }))).toMatchObject({
      kind: "Refused",
      message: expect.stringMatching(/^a reset restores .*ootb\.bak only/),
    });
    const sent = transport.requests.length;
    for (const backup of [
      { flavor: "12sp9", file: `${ROOT}\\staging\\lease-1\\db.bak`, hash: FAKE_GOLDEN_HASH },
      { flavor: "12sp9", file: "C:\\Program Files\\Aras\\olm.bak", hash: FAKE_GOLDEN_HASH },
      { flavor: "23", file: `${ROOT}\\golden\\23\\db\\ootb.bak`, hash: FAKE_GOLDEN_HASH },
    ] as const) {
      expect((await rejection(host.resetDatabase(s1, backup))).kind, backup.file).toBe("Refused");
    }
    expect((await rejection(host.resetDatabase({ flavor: "OLM_Local" as never, slot: 1 }, { flavor: "12sp9", file: ootb, hash: FAKE_GOLDEN_HASH }))).kind).toBe("Refused");
    expect(transport.requests).toHaveLength(sent);
  });

  it("backs a leased slot's database up through the broker's backupDatabase verb, guarded on both sides", async () => {
    await host.provisionSlot(s1);
    const lease = "0123456789abcdef0123456789abcdef";
    const staged = `${ROOT}\\staging\\${lease}\\extract-db-1.bak`;
    // Not leased: the broker refuses.
    expect(await rejection(host.backupDatabase(s1, staged))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not leased: only a leased slot's database is backed up" });
    slots.put(stampFile(s1, ROOT), JSON.stringify({ ...JSON.parse(slots.text(stampFile(s1, ROOT))!), leaseId: lease }));
    const done = await host.backupDatabase(s1, staged);
    expect(done).toMatchObject({ ok: true, detail: expect.stringMatching(/^backed up the database of 12sp9-01 \(COPY_ONLY, .* MB, 0\.9 s\) to extract-db-1\.bak in /) });
    expect(transport.requests.at(-1)).toMatchObject({ verb: "backupDatabase", slot: s1, args: { path: staged } });
    expect(slots.text(staged)).toBe("COPY_ONLY backup of arashouse_12sp9_01");
    const sent = transport.requests.length;
    for (const path of [`${ROOT}\\staging\\x.bak`, `${ROOT}\\golden\\12sp9\\db\\ootb.bak`, "C:\\Program Files\\Microsoft SQL Server\\olm.bak"]) {
      expect((await rejection(host.backupDatabase(s1, path))).kind, path).toBe("Refused");
    }
    expect((await rejection(host.backupDatabase({ flavor: "OLM_Local" as never, slot: 1 }, staged))).kind).toBe("Refused");
    expect(transport.requests).toHaveLength(sent);
  });

  it("health-checks a slot through the broker's healthCheck verb: every check named and timed, and the marker", async () => {
    expect(await rejection(host.healthCheck(s1))).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not provisioned" });
    const golden = slots.manifest("12sp9").manifestHash;
    slots.goldenState = { state: "ok", hash: golden };
    await host.provisionSlot(s1);
    const health = await host.healthCheck(s1);
    expect(health).toMatchObject({ ok: true, detail: expect.stringMatching(/^12sp9-01 is healthy \(9 checks in /) });
    expect(health.checks.map((c) => [c.name, c.ok])).toEqual(
      ["stamp", "client", "dblist", "oauth", "tree", "configs", "marker", "version", "login"].map((name) => [name, true]),
    );
    expect(health.checks.every((c) => typeof c.ms === "number")).toBe(true);
    expect(health.marker).toEqual({ goldenHash: golden, resetAt: expect.stringMatching(/^\d{4}-/) });
    expect(transport.requests.at(-1)).toMatchObject({ verb: "healthCheck", slot: s1 });
    expect(transport.requests.at(-1)?.args).toBeUndefined();

    slots.databaseMarkers.delete("arashouse_12sp9_01");
    const unmarked = await host.healthCheck(s1);
    expect(unmarked.ok).toBe(false);
    expect(unmarked.checks.find((c) => c.name === "marker")).toMatchObject({ ok: false, detail: "the database carries no marker" });
    expect(unmarked.marker).toEqual({ goldenHash: null, resetAt: null });
    const sent = transport.requests.length;
    expect((await rejection(host.healthCheck({ flavor: "OLM_Local" as never, slot: 1 }))).kind).toBe("Refused");
    expect(transport.requests).toHaveLength(sent);
  });

  it("verifies a golden through the broker's baselineVerify verb", async () => {
    expect(await host.baselineVerify("12sp9")).toMatchObject({ ok: false, level: "golden", detail: "the 12sp9 baseline is not built" });
    const golden = root.local(`${ROOT}\\golden\\12sp9`);
    await makeSampleTree(join(golden, "tree"));
    await writeManifestOnce(join(golden, "manifest.json"), await buildManifest(join(golden, "tree"), "12sp9", "12.0.0.24090"));
    const ok = await host.baselineVerify("12sp9");
    expect(ok).toMatchObject({ ok: true, level: "golden", goldenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(ok.diff?.counts).toEqual({ missing: 0, changed: 0, extra: 0 });
    const full = await host.baselineVerify("12sp9", { level: "full" });
    expect(full).toMatchObject({ ok: true, level: "full" });
    expect(transport.requests.map((r) => r.args)).toEqual([{ level: "golden" }, { level: "golden" }, { level: "full" }]);
    expect((await rejection(host.baselineVerify("12sp9", { level: "everything" as never }))).kind).toBe("Refused");
  });
});

describe("BrokerHost refuses an answer it cannot trust", () => {
  it.each([
    ["an answer to another request", () => ({ id: "other", ok: true, result: { ok: true, detail: "" } })],
    ["no JSON object", () => "pong"],
    ["an unknown error kind", (r: BrokerRequest) => ({ id: r.id, ok: false, error: { kind: "Fatal", message: "x" } })],
  ])("%s is Unreachable", async (_label, respond) => {
    const err = await rejection(answering(respond).ping());
    expect(err.kind).toBe("Unreachable");
    expect(err.message).toMatch(/answer to ping is malformed/);
  });

  it("hostInfo without its fields, or a stamp for another slot", async () => {
    const info = answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", info: { os: "x" } } }));
    expect((await rejection(info.hostInfo())).message).toMatch(/hostInfo is malformed: info has the wrong fields/);
    const base = { os: "x", freeRamMb: 1, freeDiskGb: 1, brokerVersion: "0", sqlReachable: true };
    const withLogin = (sqlLogin: unknown) => answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", info: { ...base, sqlLogin } } }));
    expect((await rejection(withLogin({ login: "x", sysadmin: "no", dbcreator: false, procedures: 5 }).hostInfo())).message).toMatch(/info.sqlLogin has the wrong fields/);
    expect((await withLogin(null).hostInfo()).info.sqlLogin).toBeNull();
    const login = { login: "x", sysadmin: false, dbcreator: false, procedures: 5 };
    expect((await withLogin({ ...login, maxServerMemoryMb: 4096 }).hostInfo()).info.sqlLogin).toEqual({ ...login, maxServerMemoryMb: 4096 });
    expect((await withLogin(login).hostInfo()).info.sqlLogin).toEqual(login);
    expect((await rejection(withLogin({ ...login, maxServerMemoryMb: "4096" }).hostInfo())).message).toMatch(/maxServerMemoryMb is not a count/);
    const before22 = answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", info: base } }));
    expect("sqlLogin" in (await before22.hostInfo()).info).toBe(false);
    expect("licences" in (await before22.hostInfo()).info).toBe(false);
    const withLicences = (licences: unknown) => answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", info: { ...base, licences } } }));
    expect((await withLicences([{ line: "12", present: true }]).hostInfo()).info.licences).toEqual([{ line: "12", present: true }]);
    expect((await rejection(withLicences([{ line: "12", present: true, value: "x" }]).hostInfo())).message).toMatch(/info.licences has the wrong fields/);
    expect((await rejection(withLicences({ "12": true }).hostInfo())).message).toMatch(/info.licences is not a list/);
    const stamp = { slotId: "23-01", flavor: "23", goldenHash: null, lastResetAt: null };
    const other = answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", stamp } }));
    expect((await rejection(other.readStamp(s1))).message).toMatch(/readStamp is malformed/);
  });

  it("a health check whose checks or marker have the wrong shape", async () => {
    const health = (result: Record<string, unknown>) => answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", ...result } }));
    expect((await rejection(health({ checks: "all fine" }).healthCheck(s1))).message).toMatch(/healthCheck is malformed: checks is not a list/);
    expect((await rejection(health({ checks: [{ name: "stamp", ok: "yes", detail: "" }] }).healthCheck(s1))).message).toMatch(/a check has the wrong fields/);
    expect((await rejection(health({ checks: [], marker: { goldenHash: 7, resetAt: null } }).healthCheck(s1))).message).toMatch(/marker has the wrong fields/);
    expect((await health({ checks: [], marker: null }).healthCheck(s1)).marker).toBeNull();
  });

  it("a health check is timed out only when it failed and every failed check timed out", async () => {
    const health = (result: Record<string, unknown>) => answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { detail: "", ...result } }));
    const slowLogin = { name: "login", ok: false, detail: "root's login did not answer in time", timedOut: true };
    const passed = { name: "stamp", ok: true, detail: "fine" };
    const timedOut = await health({ ok: false, timedOut: true, checks: [passed, slowLogin] }).healthCheck(s1);
    expect(timedOut).toMatchObject({ ok: false, timedOut: true });
    expect(timedOut.checks[1]).toMatchObject({ name: "login", timedOut: true });
    expect("timedOut" in timedOut.checks[0]!).toBe(false);
    // A wrong check besides, a passing result, or a check that did not time out: not timed out, whatever the broker says.
    const wrong = { name: "tree", ok: false, detail: "1 extra" };
    expect((await health({ ok: false, timedOut: true, checks: [wrong, slowLogin] }).healthCheck(s1)).timedOut).toBeUndefined();
    expect((await health({ ok: true, timedOut: true, checks: [passed] }).healthCheck(s1)).timedOut).toBeUndefined();
    expect((await health({ ok: false, timedOut: true, checks: [{ ...slowLogin, timedOut: "yes" }] }).healthCheck(s1)).timedOut).toBeUndefined();
    expect((await health({ ok: false, checks: [slowLogin] }).healthCheck(s1)).timedOut).toBeUndefined();
  });

  it("a listed slot that is not the tool's", async () => {
    for (const slot of [{ flavor: "olm", slot: 1 }, { flavor: "12sp9", slot: 1.5 }, { flavor: "12sp9", slot: 100 }]) {
      const listing = answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", slots: [{ slot, stamp: null }] } }));
      expect((await rejection(listing.listSlots())).kind).toBe("Unreachable");
    }
  });

  it("redacts a secret-shaped message from the broker", async () => {
    const leaky = answering((r: BrokerRequest) => ({ id: r.id, ok: false, error: { kind: "Retryable", message: ["tok", "en", "=", "abcdef123456"].join("") } }));
    expect((await rejection(leaky.ping())).message).toBe("token=[redacted]");
  });
});

describe("interopTransport", () => {
  const fixture = join(repoRoot, "test", "fixtures", "broker-client.mjs");
  const transportFor = (node: string = process.execPath) => interopTransport({ node, clientScript: fixture, cwd: repoRoot });

  it("runs the client with the verb's bound and returns its answer", async () => {
    const answer = await transportFor().call({ id: "echo-1", verb: "ping" }, 5000);
    expect(answer).toEqual({ id: "echo-1", ok: true, result: { ok: true, detail: "--timeout-ms 5000" } });
  });

  it("is Unreachable with the doctor hint when node.exe is missing, the client says nothing, or answers garbage", async () => {
    const missing = await rejection(transportFor(join(repoRoot, "no-such-node.exe")).call({ id: "echo-2", verb: "ping" }, 1000));
    expect(missing.kind).toBe("Unreachable");
    expect(missing.message).toMatch(/cannot start .*no-such-node\.exe \(ENOENT\).*arashouse doctor/);
    const silent = await rejection(transportFor().call({ id: "silent-1", verb: "ping" }, 1000));
    expect(silent.message).toMatch(/exited 6 with no response: cannot reach the broker/);
    expect((await rejection(transportFor().call({ id: "garbage-1", verb: "ping" }, 1000))).message).toMatch(/not JSON/);
  });

  it("starts node.exe again when WSL could not start it (the request never left WSL), a bounded number of times", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arashouse-interop-"));
    try {
      const sleeps: number[] = [];
      const transport = interopTransport({ node: process.execPath, clientScript: fixture, cwd: repoRoot, sleep: async (ms) => void sleeps.push(ms) });
      const twice = join(dir, "twice");
      const answer = await transport.call({ id: "interop-1", verb: "ping", args: { count: twice, fail: 2 } }, 5000);
      expect(answer).toMatchObject({ id: "interop-1", ok: true });
      expect(readFileSync(twice, "utf8")).toHaveLength(3);
      expect(sleeps).toEqual([INTEROP_RETRY_DELAY_MS, 2 * INTEROP_RETRY_DELAY_MS]);

      const always = join(dir, "always");
      const err = await rejection(transport.call({ id: "interop-2", verb: "ping", args: { count: always } }, 5000));
      expect(err.kind).toBe("Unreachable");
      expect(err.message).toMatch(/WSL could not start .* \(exit 1\): <3>WSL \(2925201 - \) ERROR: UtilAcceptVsock:273: accept4 failed 110; .*arashouse doctor/);
      expect(readFileSync(always, "utf8")).toHaveLength(INTEROP_START_ATTEMPTS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never starts a client again that ran: it may have handed the request to the broker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arashouse-interop-"));
    try {
      const once = join(dir, "once");
      const err = await rejection(transportFor().call({ id: "silent-2", verb: "ping", args: { count: once } }, 1000));
      expect(err.message).toMatch(/exited 6 with no response: cannot reach the broker/);
      expect(readFileSync(once, "utf8")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tells WSL's interop start failure from a client that ran", () => {
    const wsl = "<3>WSL (2925201 - ) ERROR: UtilAcceptVsock:273: accept4 failed 110\n";
    expect(isInteropStartFailure("", wsl)).toBe(true);
    expect(isInteropStartFailure("", "<3>WSL (12 - ) ERROR: UtilConnectVsock:301: connect failed 110\n")).toBe(true);
    // The client printed something, or answered: it ran.
    expect(isInteropStartFailure("", `${wsl}arashouse-broker client: cannot reach the broker at \\\\.\\pipe\\x\n`)).toBe(false);
    expect(isInteropStartFailure('{"id":"x","ok":true}\n', wsl)).toBe(false);
    // Another WSL error, or none.
    expect(isInteropStartFailure("", "<3>WSL (12 - ) ERROR: CreateProcessEntryCommon:505: execvpe failed\n")).toBe(false);
    expect(isInteropStartFailure("", "")).toBe(false);
  });

  it("gives up on a client that does not exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = rejection(transportFor().call({ id: "hang-1", verb: "ping" }, 10));
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await pending).message).toMatch(/no answer within 10010 ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});
