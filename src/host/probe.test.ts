import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSlotServer } from "./fake-slot.js";
import { isHostError } from "./errors.js";
import { forgetWarm, parseDbList, probeSlot } from "./probe.js";

const alias = "ah-12sp9-01";
const database = "arashouse_12sp9_01";
const servers: FakeSlotServer[] = [];

async function slot(options: Partial<ConstructorParameters<typeof FakeSlotServer>[0]> = {}): Promise<FakeSlotServer> {
  const server = await new FakeSlotServer({ alias, databases: [database], ...options }).start();
  servers.push(server);
  return server;
}
const urlOf = (s: FakeSlotServer) => `http://${s.address}/${alias}`;

beforeEach(() => forgetWarm());
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("parseDbList", () => {
  it("reads the ids of DB elements", () => {
    expect(parseDbList(`<DBList><DB id="a"/><DB  id='b' other="x"></DB></DBList>`)).toEqual(["a", "b"]);
    expect(parseDbList("<DBList></DBList>")).toEqual([]);
    expect(parseDbList("not xml")).toEqual([]);
  });
});

describe("probeSlot", () => {
  it("passes a good slot and reports the timing of each check", async () => {
    const s = await slot();
    const probe = await probeSlot(urlOf(s), database);
    expect(probe.ok).toBe(true);
    expect(probe.url).toBe(urlOf(s));
    expect(probe.dbList).toMatchObject({ ok: true, status: 200, databases: [database] });
    expect(probe.oauth).toMatchObject({ ok: true, status: 200 });
    expect(probe.client).toMatchObject({ ok: true, status: 200 });
    for (const c of [probe.client, probe.oauth, probe.dbList]) expect(c.ms).toBeGreaterThanOrEqual(0);
    expect(probe.ms).toBeGreaterThanOrEqual(0);
    expect([...s.requests].sort()).toEqual(
      [`/${alias}/Client/`, `/${alias}/Server/DBList.aspx`, `/${alias}/OAuthServer/.well-known/openid-configuration`].sort(),
    );
  });

  it("accepts a trailing slash on the URL", async () => {
    const s = await slot();
    expect((await probeSlot(`${urlOf(s)}/`, database)).ok).toBe(true);
  });

  it("fails a slot whose DBList lists two databases", async () => {
    const s = await slot({ databases: [database, "arashouse_12sp9_02"] });
    const probe = await probeSlot(urlOf(s), database);
    expect(probe.ok).toBe(false);
    expect(probe.dbList.ok).toBe(false);
    expect(probe.dbList.databases).toEqual([database, "arashouse_12sp9_02"]);
    expect(probe.dbList.detail).toMatch(/2 databases/);
    expect(probe.client.ok && probe.oauth.ok).toBe(true);
  });

  it("fails a slot whose one database is not its own, or whose list is empty", async () => {
    const other = await slot({ databases: ["arashouse_12sp9_02"] });
    expect((await probeSlot(urlOf(other), database)).dbList.ok).toBe(false);
    const empty = await slot({ databases: [] });
    expect((await probeSlot(urlOf(empty), database)).dbList.ok).toBe(false);
  });

  it("fails a slot answering 500 and keeps no body", async () => {
    const s = await slot({ status: 500, errorBody: "BODY_MARKER stack trace" });
    const probe = await probeSlot(urlOf(s), database);
    expect(probe.ok).toBe(false);
    expect(probe.client).toMatchObject({ ok: false, status: 500 });
    expect(probe.oauth).toMatchObject({ ok: false, status: 500 });
    expect(probe.dbList).toMatchObject({ ok: false, status: 500, databases: [] });
    expect(JSON.stringify(probe)).not.toContain("BODY_MARKER");
  });

  it("reports each failing check on its own", async () => {
    const s = await slot({ statuses: { "/OAuthServer/.well-known/openid-configuration": 404 } });
    const probe = await probeSlot(urlOf(s), database);
    expect(probe).toMatchObject({ ok: false, client: { ok: true }, oauth: { ok: false, status: 404 }, dbList: { ok: true } });
  });

  it("counts a redirect from /Client/ as answering", async () => {
    const s = await slot({ statuses: { "/Client/": 302 } });
    const probe = await probeSlot(urlOf(s), database);
    expect(probe.client).toMatchObject({ ok: true, status: 302 });
  });

  it("reports a slot nothing listens on as failed with no status", async () => {
    const s = await slot();
    const url = urlOf(s);
    await s.stop();
    const probe = await probeSlot(url, database);
    expect(probe.ok).toBe(false);
    expect(probe.client.status).toBeUndefined();
    expect(probe.client.detail).toMatch(/connection failed/);
  });

  describe("cold start", () => {
    it("waits out a slow first call, then uses the short timeout once warm", async () => {
      const s = await slot({ delayMs: 400 });
      const cold = await probeSlot(urlOf(s), database, { coldTimeoutMs: 5_000, warmTimeoutMs: 100 });
      expect(cold.ok).toBe(true);
      expect(cold.cold).toBe(true);
      expect(cold.client.ms).toBeGreaterThanOrEqual(350);

      const warm = await probeSlot(urlOf(s), database, { coldTimeoutMs: 5_000, warmTimeoutMs: 100 });
      expect(warm.cold).toBe(false);
      expect(warm.ok).toBe(false);
      expect(warm.client.detail).toMatch(/timed out after 100 ms/);
    });

    it("gives a first call that outlasts the cold timeout a timeout, not a hang", async () => {
      const s = await slot({ delayMs: 2_000 });
      const probe = await probeSlot(urlOf(s), database, { coldTimeoutMs: 100 });
      expect(probe.ok).toBe(false);
      expect(probe.cold).toBe(true);
      expect(probe.ms).toBeLessThan(1_500);
      expect(probe.dbList.detail).toMatch(/timed out/);
    });

    it("uses the long timeout again after forgetWarm or warm: false", async () => {
      const s = await slot();
      await probeSlot(urlOf(s), database);
      expect((await probeSlot(urlOf(s), database)).cold).toBe(false);
      forgetWarm(urlOf(s));
      expect((await probeSlot(urlOf(s), database)).cold).toBe(true);
      expect((await probeSlot(urlOf(s), database, { warm: false })).cold).toBe(true);
    });
  });

  describe("refusals (nothing is contacted)", () => {
    it.each([
      ["a deny-listed alias", (s: FakeSlotServer) => `http://${s.address}/12sp9`, database],
      ["InnovatorServer23", (s: FakeSlotServer) => `http://${s.address}/InnovatorServer23`, database],
      ["a database of another slot", (s: FakeSlotServer) => `http://${s.address}/${alias}`, "arashouse_23_01"],
      ["OLM_Local as the database", (s: FakeSlotServer) => `http://${s.address}/${alias}`, "OLM_Local"],
      ["https", (s: FakeSlotServer) => `https://${s.address}/${alias}`, database],
      ["credentials in the URL", (s: FakeSlotServer) => `http://user:pw@${s.address}/${alias}`, database],
      ["a path below the alias", (s: FakeSlotServer) => `http://${s.address}/${alias}/Client`, database],
      ["a query", (s: FakeSlotServer) => `http://${s.address}/${alias}?x=1`, database],
      ["no URL", () => "not a url", database],
    ])("refuses %s", async (_label, makeUrl, db) => {
      const s = await slot();
      const err = await probeSlot(makeUrl(s), db).catch((e: unknown) => e);
      expect(isHostError(err, "Refused")).toBe(true);
      expect(s.requests).toEqual([]);
    });
  });
});
