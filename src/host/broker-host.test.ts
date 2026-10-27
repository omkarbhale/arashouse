import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker, inProcessTransport } from "../broker/broker.js";
import { mappedRoot, type MappedRoot } from "../broker/mapped-fs.fixture.js";
import type { BrokerRequest } from "../broker/protocol.js";
import { registerBaselineVerbs } from "../broker/baseline-verbs.js";
import { SlotLocks, registerSlotVerbs } from "../broker/provision.js";
import { registerResetVerbs } from "../broker/reset-tree.js";
import { FakeSlotSystem } from "../broker/slot-system.fixture.js";
import { registerCoreVerbs, type BrokerSystem } from "../broker/verbs.js";
import { buildManifest, writeManifestOnce } from "../broker/manifest-fs.js";
import { makeSampleTree } from "../../test/sample-tree.js";
import { BrokerHost } from "./broker-host.js";
import { interopTransport, type BrokerTransport } from "./broker-transport.js";
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
  broker = registerResetVerbs(
    registerSlotVerbs(
      registerBaselineVerbs(registerCoreVerbs(new Broker({ root: ROOT, isReparsePoint: root.fs.isReparsePoint, realPath: root.fs.realPath }), system), system),
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

  it("every method the broker does not have yet is Unreachable, naming its ticket, after the guards", async () => {
    const calls: Record<
      Exclude<
        keyof HostDriver,
        "ping" | "hostInfo" | "readStamp" | "listSlots" | "baselineBuild" | "baselineVerify" | "provisionSlot" | "destroySlot" | "startSlot" | "stopSlot" | "quiesce" | "resetTree" | "writeStamp"
      >,
      () => Promise<unknown>
    > = {
      resetDatabase: () => host.resetDatabase(s1, { flavor: "12sp9", file: `${ROOT}\\golden\\12sp9\\db.bak`, hash: "h" }),
      deployCode: () => host.deployCode(s1, `${ROOT}\\staging\\l\\code`),
      restoreDatabase: () => host.restoreDatabase(s1, `${ROOT}\\staging\\l\\db.bak`),
      backupDatabase: () => host.backupDatabase(s1, `${ROOT}\\staging\\l\\db.bak`),
      healthCheck: () => host.healthCheck(s1),
      setLeaseCredentials: () => host.setLeaseCredentials(s1, { secretRef: LEASE_REF }),
    };
    expect(Object.keys(calls).length + 13).toBe(HOST_METHODS.length);
    for (const [method, call] of Object.entries(calls)) {
      const err = await rejection(call());
      expect(err.kind, method).toBe("Unreachable");
      expect(err.message, method).toMatch(new RegExp(`no ${method} verb yet \\(ticket \\d\\d\\)`));
    }
    expect((await rejection(host.startSlot({ flavor: "prod" as never, slot: 1 }, { agent: false }))).kind).toBe("Refused");
    expect((await rejection(host.baselineBuild("olm" as never))).kind).toBe("Refused");
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
    const before22 = answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", info: base } }));
    expect("sqlLogin" in (await before22.hostInfo()).info).toBe(false);
    const stamp = { slotId: "23-01", flavor: "23", goldenHash: null, lastResetAt: null };
    const other = answering((r: BrokerRequest) => ({ id: r.id, ok: true, result: { ok: true, detail: "", stamp } }));
    expect((await rejection(other.readStamp(s1))).message).toMatch(/readStamp is malformed/);
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
