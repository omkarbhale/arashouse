import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LICENCE_ATTRIBUTES, decodeLicence, licenceStatus } from "../core/licence.js";
import { MemorySecretStore } from "../core/secret-store.js";
import { MemoryAudit, auditLine } from "./audit.js";
import { Broker } from "./broker.js";
import { registerLicenceVerbs } from "./licence-verbs.js";
import { mappedRoot, type MappedRoot } from "./mapped-fs.fixture.js";
import type { BrokerResponse } from "./protocol.js";
import { registerCoreVerbs } from "./verbs.js";

const ROOT = "C:\\aras_installations";

// Assembled at run time so no licence-shaped literal sits in the source.
const LICENCE = {
  lic_key: ["LK", "-", "34B0", "-", "QQ12"].join(""),
  act_key: ["AK", "-", "34B1", "-", "WW34"].join(""),
  lic_type: ["Uni", "mited", "-T7"].join(""),
  company: ["Ex", "ample", " & Co"].join(""),
};

let root: MappedRoot;
let audit: MemoryAudit;
let store: MemorySecretStore;
let broker: Broker;
let n = 0;

const ask = (request: Record<string, unknown>): Promise<BrokerResponse> => broker.handle({ id: `r-${++n}`, ...request });

function noValueIn(value: unknown): void {
  const text = JSON.stringify(value);
  for (const v of Object.values(LICENCE)) expect(text).not.toContain(v);
}

beforeEach(() => {
  root = mappedRoot(ROOT);
  audit = new MemoryAudit();
  store = new MemorySecretStore();
  broker = new Broker({ root: ROOT, isReparsePoint: root.fs.isReparsePoint, realPath: root.fs.realPath, audit });
  registerCoreVerbs(broker, {
    fs: root.fs,
    brokerVersion: "9.9.9",
    os: () => "Windows_NT 10.0.26100",
    freeRamBytes: () => 1024 * 1024 * 1024,
    sqlLogin: async () => null,
    licences: () => licenceStatus(store),
  });
  registerLicenceVerbs(broker, store);
});

afterEach(() => root.cleanup());

describe("storeLicence", () => {
  it("stores the whole <License> element of a line as one secret, and answers with the line only", async () => {
    const response = await ask({ verb: "storeLicence", args: { line: "12", licence: LICENCE } });
    expect(response).toEqual({ id: "r-1", ok: true, result: { ok: true, detail: "stored the licence for line 12", line: "12" } });
    const stored = await store.get("licence-12");
    expect(stored?.kind).toBe("licence");
    const element = decodeLicence(stored!);
    expect(Object.fromEntries(LICENCE_ATTRIBUTES.map((a) => [a, element[a].reveal()]))).toEqual(LICENCE);
    expect(await store.has("licence-14")).toBe(false);
    noValueIn(audit.entries());
    noValueIn(audit.entries().map(auditLine));
    expect(audit.entries()).toEqual([expect.objectContaining({ verb: "storeLicence", target: null, outcome: "ok" })]);
  });

  it("replaces the line's earlier licence", async () => {
    await ask({ verb: "storeLicence", args: { line: "14", licence: { lic_key: "an-older-placeholder-key" } } });
    await ask({ verb: "storeLicence", args: { line: "14", licence: LICENCE } });
    expect(decodeLicence((await store.get("licence-14"))!).act_key.reveal()).toBe(LICENCE.act_key);
  });

  it.each([
    ["no line", { licence: LICENCE }, /needs a licence line: 12 or 14/],
    ["an unknown line", { line: "99", licence: LICENCE }, /needs a licence line/],
    ["no licence", { line: "12" }, /needs the licence as/],
    ["no lic_key", { line: "12", licence: { ...LICENCE, lic_key: "" } }, /the licence has no lic_key/],
    ["an unknown attribute", { line: "12", licence: { ...LICENCE, password: LICENCE.act_key } }, /no "password" attribute/],
    ["a value that is not text", { line: "12", licence: { ...LICENCE, company: 1 } }, /company is not a string/],
    ["an unknown argument", { line: "12", licence: LICENCE, extra: LICENCE.lic_key }, /takes only "line" and "licence"/],
  ])("refuses %s, naming no value and storing nothing", async (_name, args, message) => {
    const response = await ask({ verb: "storeLicence", args });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.kind).toBe("Refused");
      expect(response.error.message).toMatch(message);
    }
    noValueIn(response);
    noValueIn(audit.entries());
    expect(store.size).toBe(0);
  });

  it("is not a host-driver method, and takes no target", async () => {
    const response = await ask({ verb: "storeLicence", slot: { flavor: "12sp9", slot: 1 }, args: { line: "12", licence: LICENCE } });
    expect(response.ok).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe("hostInfo's licence report", () => {
  it("says for each line whether a licence is stored, a boolean only", async () => {
    await ask({ verb: "storeLicence", args: { line: "12", licence: LICENCE } });
    const response = await ask({ verb: "hostInfo" });
    if (!response.ok) throw new Error("hostInfo failed");
    expect((response.result.info as Record<string, unknown>).licences).toEqual([
      { line: "12", present: true },
      { line: "14", present: false },
    ]);
    noValueIn(response);
  });
});
