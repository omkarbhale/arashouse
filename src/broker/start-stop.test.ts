import { describe, expect, it } from "vitest";
import { DEFAULT_INSTALL_ROOT, agentHealthUrl, agentUrl, slotNames, type SlotRef } from "../core/names.js";
import { HostError } from "../host/errors.js";
import { Broker } from "./broker.js";
import { provisionSlotOnHost, registerSlotVerbs } from "./provision.js";
import { FakeSlotSystem } from "./slot-system.fixture.js";
import { WARM_PATHS, parseStartArgs, startSlotOnHost, stopSlotOnHost } from "./start-stop.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const names = slotNames(s1, ROOT);

async function provisioned(): Promise<FakeSlotSystem> {
  const system = new FakeSlotSystem();
  await provisionSlotOnHost(system, s1, names, ROOT);
  system.calls.length = 0;
  return system;
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

const start = (system: FakeSlotSystem, agent: boolean) => startSlotOnHost(system, s1, names, ROOT, { agent });

describe("startSlot", () => {
  it("starts the pools and warms the client, the server and the OAuth server, leaving the agent stopped", async () => {
    const system = await provisioned();
    system.agentInstalled = true;
    const result = await start(system, false);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/^started 12sp9-01 in [\d.]+ s \(7 pools; agent not started; warm Client\/ 200 0\.1 s, Server\/DBList\.aspx 200 0\.1 s, OAuthServer\/\.well-known\/openid-configuration 200 0\.1 s; start [\d.]+, warm [\d.]+\)$/);
    expect(system.warmed).toEqual(WARM_PATHS.map((p) => `http://localhost/ah-12sp9-01/${p}`));
    expect(system.running.has("12sp9-01")).toBe(true);
    expect(system.agentRunning.size).toBe(0);
  });

  it("starts the agent only when asked, on the slot's reserved port, and asks its health endpoint", async () => {
    const system = await provisioned();
    system.agentInstalled = true;
    const result = await start(system, true);
    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining("agent ArasHouseAgent_12sp9_01 running on port 8801") });
    expect(result.detail).toContain("agent 200 0.1 s");
    expect(system.agentRunning.has("12sp9-01")).toBe(true);
    // 12.0's WCF agent serves its WSDL under the slot's alias; 14.x's answers /health.
    expect(system.warmed).toContain("http://localhost:8801/ah-12sp9-01?wsdl");
    expect(agentHealthUrl("23", agentUrl({ flavor: "23", slot: 2 }))).toBe("http://localhost:8902/health");
  });

  it("answers ok: false when the agent runs but its health endpoint does not answer; a credentials challenge is an answer", async () => {
    const system = await provisioned();
    system.agentInstalled = true;
    system.warmAnswer = (url) => (url.includes(":8801/") ? { ms: 30_000, error: "connection refused" } : { status: 200, ms: 10 });
    const down = await start(system, true);
    expect(down.ok).toBe(false);
    expect(down.detail).toMatch(/^started but not warm: 12sp9-01 .*agent connection refused 30\.0 s/);
    system.warmAnswer = (url) => (url.includes(":8801/") ? { status: 401, ms: 10 } : { status: 200, ms: 10 });
    expect((await start(system, true)).ok).toBe(true);
    system.warmAnswer = (url) => (url.includes(":8801/") ? { status: 500, ms: 10 } : { status: 200, ms: 10 });
    expect((await start(system, true)).ok).toBe(false);
  });

  it("refuses the agent of a slot whose golden has none, naming the rebuild that adds it", async () => {
    const system = await provisioned();
    const err = await failure(start(system, true));
    expect(err.kind).toBe("Refused");
    expect(err.message).toBe("slot 12sp9-01 has no agent service: the 12sp9 golden was built without one (rebuild it: baseline build 12sp9 --replace)");
  });

  it("answers ok: false, naming the URL, when a warm-up does not answer", async () => {
    const system = await provisioned();
    system.warmAnswer = (url) => (url.endsWith("DBList.aspx") ? { status: 503, ms: 20 } : url.includes("OAuth") ? { ms: 120_000, error: "timed out after 120000 ms" } : { status: 302, ms: 10 });
    const result = await start(system, false);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^started but not warm: 12sp9-01 .*Client\/ 302 .*Server\/DBList\.aspx 503 .*openid-configuration timed out after 120000 ms 120\.0 s/);
  });

  it("refuses a slot that is not provisioned, and a start step that fails is Retryable through the broker", async () => {
    expect((await failure(start(new FakeSlotSystem(), false))).message).toBe("slot 12sp9-01 is not provisioned");
    const system = await provisioned();
    system.failNext("start", new Error("the pool ah-12sp9-01-server did not start (Stopped)"));
    const broker = registerSlotVerbs(new Broker({ root: ROOT }), system);
    const response = await broker.handle({ id: "r1", verb: "startSlot", slot: s1, args: { agent: false } });
    expect(response).toEqual({ id: "r1", ok: false, error: { kind: "Retryable", message: "the broker failed: the pool ah-12sp9-01-server did not start (Stopped)" } });
  });
});

describe("stopSlot", () => {
  it("stops the agent and the pools, and again without harm", async () => {
    const system = await provisioned();
    system.agentInstalled = true;
    await start(system, true);
    expect(await stopSlotOnHost(system, s1, ROOT)).toMatchObject({ ok: true, detail: expect.stringMatching(/^stopped 12sp9-01 in [\d.]+ s \(7 pools; agent stopped\)$/) });
    expect(system.running.size + system.agentRunning.size).toBe(0);
    expect((await stopSlotOnHost(system, s1, ROOT)).ok).toBe(true);
  });

  it("says when the slot has no agent, and is Retryable when the stop fails", async () => {
    const system = await provisioned();
    expect((await stopSlotOnHost(system, s1, ROOT)).detail).toMatch(/\(7 pools; no agent\)$/);
    system.failNext("stop", new Error("1 worker process(es) of ah-12sp9-01 did not end"));
    const err = await failure(stopSlotOnHost(system, s1, ROOT));
    expect(err).toMatchObject({ kind: "Retryable", message: "stop of 12sp9-01 failed: 1 worker process(es) of ah-12sp9-01 did not end" });
    expect((await failure(stopSlotOnHost(new FakeSlotSystem(), s1, ROOT))).kind).toBe("Refused");
  });
});

describe("the start and stop verbs' guards", () => {
  it("take only a boolean agent: a request cannot name a service, a pool or a path", () => {
    expect(parseStartArgs({})).toEqual({ agent: false });
    expect(parseStartArgs({ agent: true })).toEqual({ agent: true });
    expect(() => parseStartArgs({ agent: "yes" })).toThrow(/agent is true or false/);
    expect(() => parseStartArgs({ agent: true, service: "ArasInnovatorAgent_ArasInnovatorAgent12" })).toThrow(/takes only "agent", not "service"/);
  });

  it("refuse, through the broker, any attempt to control ArasInnovatorAgent_ArasInnovatorAgent12, and touch nothing", async () => {
    const system = await provisioned();
    const broker = registerSlotVerbs(new Broker({ root: ROOT }), system);
    const attempts: unknown[] = [
      { id: "a1", verb: "startSlot", slot: s1, args: { agent: true, service: "ArasInnovatorAgent_ArasInnovatorAgent12" } },
      { id: "a2", verb: "stopSlot", slot: s1, args: { service: "ArasInnovatorAgent_ArasInnovatorAgent12" } },
      { id: "a3", verb: "stopSlot", slot: { flavor: "ArasInnovatorAgent_ArasInnovatorAgent12", slot: 1 } },
      { id: "a4", verb: "startSlot", slot: { flavor: "12sp9", slot: 1, service: "ArasInnovatorAgent_ArasInnovatorAgent12" }, args: { agent: true } },
      { id: "a5", verb: "stopSlot", flavor: "ArasInnovatorAgent_ArasInnovatorAgent12" },
    ];
    for (const request of attempts) {
      const response = await broker.handle(request);
      expect(response.ok, JSON.stringify(request)).toBe(false);
      expect(response.ok ? undefined : response.error.kind).toBe("Refused");
    }
    expect(system.calls).toEqual([]);
  });

  it("run one at a time per slot with provision and destroy", async () => {
    const system = await provisioned();
    const broker = registerSlotVerbs(new Broker({ root: ROOT }), system);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const original = system.start.bind(system);
    system.start = async (slot, options) => {
      await held;
      return original(slot, options);
    };
    const first = broker.handle({ id: "b1", verb: "startSlot", slot: s1, args: { agent: false } });
    await new Promise((r) => setTimeout(r, 10));
    const second = await broker.handle({ id: "b2", verb: "destroySlot", slot: s1 });
    expect(second).toMatchObject({ ok: false, error: { kind: "Retryable", message: "slot 12sp9-01 is being provisioned, destroyed, started, stopped or reset already" } });
    release();
    expect(await first).toMatchObject({ ok: true });
  });
});
