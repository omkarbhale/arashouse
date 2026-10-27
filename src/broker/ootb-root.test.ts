import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../core/secret-store.js";
import { MemoryAudit, auditLine } from "./audit.js";
import { Broker } from "./broker.js";
import { mappedRoot, type MappedRoot } from "./mapped-fs.fixture.js";
import { registerOotbRootVerb } from "./ootb-root.js";
import type { BrokerResponse } from "./protocol.js";

const ROOT = "C:\\aras_installations";

// Assembled at run time so no password-shaped literal sits in the source.
const PASSWORD = ["golden", "-", "35", "-", "root"].join("");
const OLDER = ["an", "older", "placeholder"].join("-");
const EMPTY = "";

let root: MappedRoot;
let audit: MemoryAudit;
let store: MemorySecretStore;
let broker: Broker;
let n = 0;

const ask = (request: Record<string, unknown>): Promise<BrokerResponse> => broker.handle({ id: `r-${++n}`, ...request });

function noValueIn(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(PASSWORD);
}

beforeEach(() => {
  root = mappedRoot(ROOT);
  audit = new MemoryAudit();
  store = new MemorySecretStore();
  broker = new Broker({ root: ROOT, isReparsePoint: root.fs.isReparsePoint, realPath: root.fs.realPath, audit });
  registerOotbRootVerb(broker, store);
});

afterEach(() => root.cleanup());

describe("storeOotbRoot", () => {
  it("stores the golden backup's root password as ootb-root-<key>, and answers with the flavor only", async () => {
    const response = await ask({ verb: "storeOotbRoot", args: { flavor: "12sp9", password: PASSWORD } });
    expect(response).toEqual({ id: "r-1", ok: true, result: { ok: true, detail: "stored the golden backup's root password for 12sp9", flavor: "12sp9" } });
    const stored = await store.get("ootb-root-12sp9");
    expect(stored?.kind).toBe("aras-login");
    expect(stored?.reveal()).toBe(PASSWORD);
    expect(await store.has("ootb-root-23")).toBe(false);
    noValueIn(response);
    noValueIn(audit.entries());
    noValueIn(audit.entries().map(auditLine));
    expect(audit.entries()).toEqual([expect.objectContaining({ verb: "storeOotbRoot", target: null, outcome: "ok" })]);
  });

  it("replaces the flavor's earlier password", async () => {
    await ask({ verb: "storeOotbRoot", args: { flavor: "23", password: OLDER } });
    await ask({ verb: "storeOotbRoot", args: { flavor: "23", password: PASSWORD } });
    expect((await store.get("ootb-root-23"))?.reveal()).toBe(PASSWORD);
  });

  it.each([
    ["no flavor", { password: PASSWORD }, /needs a flavor: 12sp9, 23, 35/],
    ["an unknown flavor", { flavor: "olm", password: PASSWORD }, /needs a flavor/],
    ["no password", { flavor: "12sp9" }, /needs the password as a string/],
    ["an empty password", { flavor: "12sp9", password: EMPTY }, /needs the password as a string/],
    ["a password with a control character", { flavor: "12sp9", password: `${PASSWORD}\n` }, /1 to 128 printable ASCII characters/],
    ["a password that is too long", { flavor: "12sp9", password: PASSWORD.repeat(10) }, /1 to 128 printable ASCII characters/],
    ["an unknown argument", { flavor: "12sp9", password: PASSWORD, extra: PASSWORD }, /takes only "flavor" and "password"/],
  ])("refuses %s, naming no value and storing nothing", async (_name, args, message) => {
    const response = await ask({ verb: "storeOotbRoot", args });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).toMatch(message);
    noValueIn(response);
    noValueIn(audit.entries().map(auditLine));
    for (const flavor of ["12sp9", "23", "35"]) expect(await store.has(`ootb-root-${flavor}`)).toBe(false);
  });
});
