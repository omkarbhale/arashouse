import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker, inProcessTransport } from "../broker/broker.js";
import { mappedRoot, type MappedRoot } from "../broker/mapped-fs.fixture.js";
import type { BrokerRequest } from "../broker/protocol.js";
import { registerCoreVerbs } from "../broker/verbs.js";
import { BrokerHost } from "./broker-host.js";
import { interopTransport, type BrokerTransport } from "./broker-transport.js";
import { FakeClock } from "./clock.js";
import { HOST_METHODS, type HostDriver } from "./driver.js";
import { HostError } from "./errors.js";

const ROOT = "C:\\aras_installations";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const s1 = { flavor: "12sp9", slot: 1 } as const;

let root: MappedRoot;
let broker: Broker;
let transport: BrokerTransport & { requests: BrokerRequest[] };
let host: BrokerHost;

beforeEach(() => {
  root = mappedRoot(ROOT);
  broker = registerCoreVerbs(new Broker({ root: ROOT, isReparsePoint: root.fs.isReparsePoint, realPath: root.fs.realPath }), {
    fs: root.fs,
    brokerVersion: "0.1.0",
    os: () => "Windows_NT 10.0.26100",
    freeRamBytes: () => 8 * 1024 * 1024 * 1024,
    sqlReachable: async () => true,
  });
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
    expect(info).toMatchObject({ os: "Windows_NT 10.0.26100", freeRamMb: 8192, brokerVersion: "0.1.0", sqlReachable: true });
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
    const calls: Record<Exclude<keyof HostDriver, "ping" | "hostInfo" | "readStamp" | "listSlots">, () => Promise<unknown>> = {
      provisionSlot: () => host.provisionSlot(s1),
      destroySlot: () => host.destroySlot(s1),
      quiesce: () => host.quiesce(s1),
      resetTree: () => host.resetTree(s1, { flavor: "12sp9", hash: "h" }),
      resetDatabase: () => host.resetDatabase(s1, { flavor: "12sp9", file: `${ROOT}\\golden\\12sp9\\db.bak`, hash: "h" }),
      startSlot: () => host.startSlot(s1, { agent: false }),
      stopSlot: () => host.stopSlot(s1),
      deployCode: () => host.deployCode(s1, `${ROOT}\\staging\\l\\code`),
      restoreDatabase: () => host.restoreDatabase(s1, `${ROOT}\\staging\\l\\db.bak`),
      backupDatabase: () => host.backupDatabase(s1, `${ROOT}\\staging\\l\\db.bak`),
      healthCheck: () => host.healthCheck(s1),
      writeStamp: () => host.writeStamp(s1, { slotId: "12sp9-01", flavor: "12sp9", goldenHash: null, lastResetAt: null }),
      setLeaseCredentials: () => host.setLeaseCredentials(s1, { secretRef: "x" }),
      baselineBuild: () => host.baselineBuild("12sp9"),
      baselineVerify: () => host.baselineVerify("12sp9"),
    };
    expect(Object.keys(calls).length + 4).toBe(HOST_METHODS.length);
    for (const [method, call] of Object.entries(calls)) {
      const err = await rejection(call());
      expect(err.kind, method).toBe("Unreachable");
      expect(err.message, method).toMatch(new RegExp(`no ${method} verb yet \\(ticket \\d\\d\\)`));
    }
    expect((await rejection(host.quiesce({ flavor: "prod" as never, slot: 1 }))).kind).toBe("Refused");
    expect((await rejection(host.baselineBuild("olm" as never))).kind).toBe("Refused");
    expect(transport.requests).toEqual([]);
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
    const leaky = answering((r: BrokerRequest) => ({ id: r.id, ok: false, error: { kind: "Retryable", message: "token=abcdef123456" } }));
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
