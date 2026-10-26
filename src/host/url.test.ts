import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSlotServer, closedAddress } from "./fake-slot.js";
import { isHostError } from "./errors.js";
import { HOST_ADDR_ENV, hostAddress, isHostAddress, parseDefaultGateway, resetHostAddressCache, slotUrl } from "./url.js";

const alias = "ah-12sp9-01";
const servers: FakeSlotServer[] = [];

async function slotServer(options: Partial<ConstructorParameters<typeof FakeSlotServer>[0]> = {}): Promise<FakeSlotServer> {
  const server = await new FakeSlotServer({ alias, ...options }).start();
  servers.push(server);
  return server;
}

beforeEach(() => resetHostAddressCache());
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("parseDefaultGateway", () => {
  it("reads the gateway of the default route", () => {
    const out = "default via 172.19.0.1 dev eth0 proto kernel\n172.19.0.0/20 dev eth0 proto kernel scope link src 172.19.1.2\n";
    expect(parseDefaultGateway(out)).toBe("172.19.0.1");
  });

  it("is undefined without a default route or with a non-IPv4 gateway", () => {
    expect(parseDefaultGateway("")).toBeUndefined();
    expect(parseDefaultGateway("172.19.0.0/20 dev eth0 scope link\n")).toBeUndefined();
    expect(parseDefaultGateway("default via fe80::1 dev eth0\n")).toBeUndefined();
  });
});

describe("isHostAddress and slotUrl", () => {
  it.each(["172.19.0.1", "localhost", "127.0.0.1:8080", "host-1.local"])("accepts %s", (a) => {
    expect(isHostAddress(a)).toBe(true);
  });

  it.each(["", "http://localhost", "a/b", "user@host", "host:", "-host", "a b"])("rejects %j", (a) => {
    expect(isHostAddress(a)).toBe(false);
  });

  it("joins an address and an owned alias", () => {
    expect(slotUrl("172.19.0.1", alias)).toBe("http://172.19.0.1/ah-12sp9-01");
  });

  it.each(["12sp9", "OLM_Local", "InnovatorServer23", "ah-12sp9-01/../x"])("refuses the alias %s", (a) => {
    expect(() => slotUrl("172.19.0.1", a)).toThrow(/refused/);
  });
});

describe("hostAddress", () => {
  it("uses the override without probing it", async () => {
    const gateway = await slotServer();
    const address = await hostAddress(alias, {
      env: { [HOST_ADDR_ENV]: "10.9.8.7" },
      gateway: () => gateway.address,
    });
    expect(address).toBe("10.9.8.7");
    expect(gateway.requests).toEqual([]);
  });

  it("refuses an override that is not a host address", async () => {
    const err = await hostAddress(alias, { env: { [HOST_ADDR_ENV]: "http://evil/x" } }).catch((e: unknown) => e);
    expect(isHostError(err, "Refused")).toBe(true);
  });

  it("prefers the gateway when it answers, and does not try localhost", async () => {
    const gateway = await slotServer();
    const loopback = await slotServer();
    const address = await hostAddress(alias, { env: {}, gateway: () => gateway.address, loopback: loopback.address });
    expect(address).toBe(gateway.address);
    expect(gateway.requests).toEqual([`/${alias}/Client/`, `/${alias}/DBList.aspx`]);
    expect(loopback.requests).toEqual([]);
  });

  it("falls back to localhost when the gateway refuses the connection", async () => {
    const loopback = await slotServer();
    const address = await hostAddress(alias, { env: {}, gateway: closedAddress, loopback: loopback.address });
    expect(address).toBe(loopback.address);
  });

  it("falls back to localhost when the gateway answers 404 for the alias", async () => {
    const gateway = await slotServer({ alias: "someone-else" });
    const loopback = await slotServer();
    const address = await hostAddress(alias, { env: {}, gateway: () => gateway.address, loopback: loopback.address });
    expect(address).toBe(loopback.address);
    expect(gateway.requests).toEqual([`/${alias}/Client/`]);
  });

  it("falls back to localhost when the gateway does not answer in time", async () => {
    const gateway = await slotServer({ delayMs: 2_000 });
    const loopback = await slotServer();
    const address = await hostAddress(alias, {
      env: {},
      gateway: () => gateway.address,
      loopback: loopback.address,
      timeoutMs: 100,
    });
    expect(address).toBe(loopback.address);
  });

  it("tries only localhost when no gateway can be read", async () => {
    const loopback = await slotServer();
    const address = await hostAddress(alias, { env: {}, gateway: () => undefined, loopback: loopback.address });
    expect(address).toBe(loopback.address);
  });

  it("skips a gateway that is a LAN router answering 302 to everything, and localhost wins", async () => {
    const gateway = await new FakeSlotServer({ alias, status: 302 }).start();
    servers.push(gateway);
    const loopback = await slotServer();
    const address = await hostAddress(alias, { env: {}, gateway: () => gateway.address, loopback: loopback.address });
    expect(address).toBe(loopback.address);
    expect(await hostAddress(alias, { env: {}, gateway: () => gateway.address, loopback: loopback.address })).toBe(loopback.address);
  });

  it("does not find a slot that answers 500 on every path", async () => {
    const gateway = await slotServer({ status: 500 });
    await expect(
      hostAddress(alias, { env: {}, gateway: () => gateway.address, loopback: await closedAddress() }),
    ).rejects.toThrow(/no host address/);
  });

  it("is Unreachable when no candidate answers, naming what it tried", async () => {
    const dead = await closedAddress();
    const err = await hostAddress(alias, { env: {}, gateway: () => dead, loopback: "127.0.0.1:1" }).catch((e: unknown) => e);
    expect(isHostError(err, "Unreachable")).toBe(true);
    expect(String(err)).toContain(dead);
    expect(String(err)).toContain("127.0.0.1:1");
  });

  it("caches the answer for the process, and a failure is not cached", async () => {
    const dead = await closedAddress();
    await expect(hostAddress(alias, { env: {}, gateway: () => dead, loopback: dead })).rejects.toThrow(/no host address/);

    const first = await slotServer();
    expect(await hostAddress(alias, { env: {}, gateway: () => first.address, loopback: dead })).toBe(first.address);
    const second = await slotServer();
    expect(await hostAddress(alias, { env: {}, gateway: () => second.address, loopback: dead })).toBe(first.address);
    expect(second.requests).toEqual([]);
  });

  it("refuses an alias the tool does not own before contacting anything", async () => {
    const gateway = await slotServer();
    await expect(hostAddress("12sp9", { env: {}, gateway: () => gateway.address })).rejects.toThrow(/refused/);
    expect(gateway.requests).toEqual([]);
  });
});
