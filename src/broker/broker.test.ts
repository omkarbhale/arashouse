import { mkdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Secret } from "../core/secret.js";
import { HostError } from "../host/errors.js";
import { FileAudit, MemoryAudit, auditLine, type AuditEntry } from "./audit.js";
import { Broker, inProcessTransport } from "./broker.js";
import { mappedRoot, type MappedRoot } from "./mapped-fs.fixture.js";
import type { BrokerResponse } from "./protocol.js";
import { registerCoreVerbs, type BrokerSystem } from "./verbs.js";

const LEASE_REF = "lease-1";

const ROOT = "C:\\aras_installations";
const s1 = { flavor: "12sp9", slot: 1 } as const;
const s2 = { flavor: "23", slot: 2 } as const;

let root: MappedRoot;
let audit: MemoryAudit;
let broker: Broker;
let system: BrokerSystem;
let n = 0;

const ask = (request: Record<string, unknown>): Promise<BrokerResponse> => broker.handle({ id: `r-${++n}`, ...request });

function failure(response: BrokerResponse) {
  if (response.ok) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  return response.error;
}

function result(response: BrokerResponse) {
  if (!response.ok) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  return response.result;
}

beforeEach(() => {
  root = mappedRoot(ROOT);
  audit = new MemoryAudit();
  system = {
    fs: root.fs,
    brokerVersion: "9.9.9",
    os: () => "Windows_NT 10.0.26100",
    freeRamBytes: () => 3.5 * 1024 * 1024 * 1024,
    sqlLogin: async () => ({ login: "NT SERVICE\\ArasHouseBroker", sysadmin: false, dbcreator: false, procedures: 5 }),
  };
  broker = registerCoreVerbs(new Broker({ root: ROOT, isReparsePoint: root.fs.isReparsePoint, realPath: root.fs.realPath, audit }), system);
});

afterEach(() => root.cleanup());

describe("the core verbs", () => {
  it("registers ping, hostInfo, readStamp and listSlots, and only those", () => {
    expect(broker.registered()).toEqual(["ping", "hostInfo", "readStamp", "listSlots"]);
  });

  it("ping answers with the broker's version", async () => {
    const response = await ask({ verb: "ping" });
    expect(result(response)).toEqual({ ok: true, detail: "arashouse-broker 9.9.9" });
    expect(audit.entries()).toEqual([expect.objectContaining({ id: "r-1", verb: "ping", target: null, outcome: "ok" })]);
  });

  it("hostInfo reports the OS, free RAM and disk, the version and SQL", async () => {
    const info = result(await ask({ verb: "hostInfo" })).info as Record<string, unknown>;
    expect(info).toMatchObject({ os: "Windows_NT 10.0.26100", freeRamMb: 3584, brokerVersion: "9.9.9", sqlReachable: true, sqlLogin: { sysadmin: false, procedures: 5 } });
    expect(typeof info.freeDiskGb).toBe("number");
    expect(info.freeDiskGb as number).toBeGreaterThanOrEqual(0);
  });

  it("readStamp reads the slot's stamp, or null when it has none", async () => {
    root.slot(s1);
    root.slot(s2, null);
    expect(result(await ask({ verb: "readStamp", slot: s1 })).stamp).toEqual({
      slotId: "12sp9-01",
      flavor: "12sp9",
      goldenHash: "g1",
      lastResetAt: "2026-10-27T00:00:00.000Z",
    });
    expect(result(await ask({ verb: "readStamp", slot: s2 }))).toEqual({ ok: true, detail: "no stamp for 23-02", stamp: null });
    expect(audit.entries().map((e) => [e.verb, e.target, e.outcome])).toEqual([
      ["readStamp", "12sp9-01", "ok"],
      ["readStamp", "23-02", "ok"],
    ]);
  });

  it("readStamp refuses a slot that is not provisioned, and quarantines an unusable stamp", async () => {
    expect(failure(await ask({ verb: "readStamp", slot: s1 }))).toEqual({ kind: "Refused", message: "slot 12sp9-01 is not provisioned" });
    root.slot(s1, "{not json");
    expect(failure(await ask({ verb: "readStamp", slot: s1 }))).toMatchObject({ kind: "Quarantine", message: expect.stringMatching(/not JSON/) });
    root.slot(s1, { slotId: "23-02", flavor: "23", goldenHash: null, lastResetAt: null });
    expect(failure(await ask({ verb: "readStamp", slot: s1 })).message).toMatch(/names 23-02, not 12sp9-01/);
  });

  it("readStamp runs the guards first: a foreign name or a junction in the slot's path is refused", async () => {
    const readText = vi.spyOn(root.fs, "readText");
    for (const slot of [{ flavor: "OLM_Local", slot: 1 }, { flavor: "12sp9", slot: 0 }, { flavor: "12sp9", slot: 100 }]) {
      expect(failure(await ask({ verb: "readStamp", slot })).kind).toBe("Refused");
    }
    root.slot(s2);
    root.linkSlot(s1, root.local(`${ROOT}\\slots\\23\\02`));
    expect(failure(await ask({ verb: "readStamp", slot: s1 })).message).toMatch(/junction or reparse point/);
    expect(readText).not.toHaveBeenCalled();
    expect(audit.entries().map((e) => e.outcome)).toEqual(["Refused", "Refused", "Refused", "Refused"]);
    expect(audit.entries()[0]?.target).toBeNull();
  });

  it("listSlots lists the tool's slot folders and skips everything else", async () => {
    root.slot(s1);
    root.slot(s2, null);
    root.slot({ flavor: "35", slot: 3 }, "{");
    for (const odd of ["slots\\olm\\01", "slots\\12SP9\\02", "slots\\12sp9\\00", "slots\\12sp9\\xx", "slots\\12sp9\\100"]) {
      mkdirSync(root.local(`${ROOT}\\${odd}`), { recursive: true });
    }
    root.linkSlot({ flavor: "12sp9", slot: 5 }, root.local(`${ROOT}\\slots\\23\\02`));
    const listed = result(await ask({ verb: "listSlots" }));
    expect(listed.slots).toEqual([
      { slot: s1, stamp: expect.objectContaining({ slotId: "12sp9-01" }) },
      { slot: s2, stamp: null },
      { slot: { flavor: "35", slot: 3 }, stamp: null },
    ]);
    expect(listed.detail).toBe("3 slots (3 folders skipped, 1 stamps unusable)");
  });

  it("listSlots on a host with no slots folder lists nothing", async () => {
    expect(result(await ask({ verb: "listSlots" }))).toEqual({ ok: true, detail: "0 slots", slots: [] });
  });
});

describe("requests the broker refuses", () => {
  it("a verb it does not have, naming it", async () => {
    expect(failure(await ask({ verb: "quiesce", slot: s1 }))).toEqual({ kind: "Refused", message: 'the broker has no "quiesce" verb' });
    expect(audit.entries()[0]).toMatchObject({ verb: "quiesce", target: "12sp9-01", outcome: "Refused" });
  });

  it("a target the verb does not take, or a missing one", async () => {
    expect(failure(await ask({ verb: "ping", slot: s1 })).message).toBe("ping names no slot or flavor");
    expect(failure(await ask({ verb: "listSlots", flavor: "23" })).message).toBe("listSlots names no slot or flavor");
    expect(failure(await ask({ verb: "readStamp" })).message).toBe("readStamp needs a slot");
  });

  it("arguments to a verb that takes none", async () => {
    expect(failure(await ask({ verb: "ping", args: { command: "whoami" } })).message).toBe("ping takes no arguments");
  });

  it("a malformed request, audited without its id, verb or target", async () => {
    const response = await broker.handle({ id: "r-x", verb: "ping", sql: "DROP DATABASE OLM_Local" });
    expect(response).toEqual({ id: "r-x", ok: false, error: { kind: "Refused", message: 'a request has no "sql" field' } });
    expect(audit.entries()[0]).toMatchObject({ id: null, verb: null, target: null, outcome: "malformed" });
    expect(audit.lines[0]).not.toMatch(/DROP|OLM/);
  });

  it("refuses to register a verb twice", () => {
    expect(() => broker.register("ping", { target: "none", run: async () => ({ ok: true, detail: "" }) })).toThrow(/already has/);
  });
});

describe("failures inside a verb", () => {
  const secret = Secret.of(["tok", "Zq81", "-x77"].join(""), "lease-password");

  it("an unexpected error is Retryable, its message redacted", async () => {
    broker.register("stopSlot", {
      target: "slot",
      run: async () => {
        throw new Error(`EBUSY while holding ${secret.reveal()}`);
      },
    });
    const error = failure(await ask({ verb: "stopSlot", slot: s1 }));
    expect(error.kind).toBe("Retryable");
    expect(error.message).toBe("the broker failed: EBUSY while holding [redacted]");
  });

  it("a HostError keeps its kind", async () => {
    broker.register("quiesce", {
      target: "slot",
      run: async () => {
        throw new HostError("Quarantine", "pools would not stop");
      },
    });
    expect(failure(await ask({ verb: "quiesce", slot: s1 }))).toEqual({ kind: "Quarantine", message: "pools would not stop" });
  });

  it("a verb that overruns its bound is answered Retryable", async () => {
    broker.register("startSlot", { target: "slot", timeoutMs: 20, run: () => new Promise(() => {}) });
    expect(failure(await ask({ verb: "startSlot", slot: s1 }))).toEqual({ kind: "Retryable", message: "startSlot did not finish within 20 ms" });
  });

  it("a verb's arguments and secrets never reach the audit log; its detail is redacted", async () => {
    broker.register("setLeaseCredentials", {
      target: "slot",
      args: (args) => args,
      run: async () => ({ ok: true, detail: `set password=${secret.reveal()}` }),
    });
    const response = await ask({ verb: "setLeaseCredentials", slot: s1, args: { secretRef: LEASE_REF, value: secret.reveal() } });
    expect(result(response).detail).toBe("set password=[redacted]");
    expect(audit.lines.join("\n")).not.toContain(secret.reveal());
    expect(audit.lines.join("\n")).not.toContain("lease-1");
    expect(Object.keys(audit.entries()[0] as object)).toEqual(["time", "id", "verb", "target", "outcome", "ms"]);
  });

  it("a verb answering ok: false is audited not-ok", async () => {
    broker.register("healthCheck", { target: "slot", run: async () => ({ ok: false, detail: "failed: stamp", checks: [] }) });
    expect(result(await ask({ verb: "healthCheck", slot: s1 })).ok).toBe(false);
    expect(audit.entries()[0]?.outcome).toBe("not-ok");
  });
});

describe("the audit log", () => {
  const entry: AuditEntry = { time: "2026-10-27T23:59:59.000Z", id: "r-1", verb: "ping", target: null, outcome: "ok", ms: 3 };

  it("is one JSON line of fixed fields, redacted", () => {
    const sneaky = { ...entry, verb: ["pass", "word", "=", "hunter22"].join(""), extra: "x" } as AuditEntry;
    expect(auditLine(sneaky)).toBe('{"time":"2026-10-27T23:59:59.000Z","id":"r-1","verb":"password=[redacted]","target":null,"outcome":"ok","ms":3}');
  });

  it("goes to <root>\\logs\\broker-YYYYMMDD.log by the entry's UTC day", async () => {
    const audit = new FileAudit(ROOT, {
      append: (file, text) => appendFile(root.local(file), text),
      mkdirp: async (dir) => void (await mkdir(root.local(dir), { recursive: true })),
    });
    await audit.write(entry);
    await audit.write({ ...entry, time: "2026-10-28T00:00:01.000Z", id: "r-2" });
    expect(readFileSync(root.local(`${ROOT}\\logs\\broker-20261027.log`), "utf8")).toBe(`${auditLine(entry)}\n`);
    expect(readFileSync(root.local(`${ROOT}\\logs\\broker-20261028.log`), "utf8")).toContain('"id":"r-2"');
  });

  it("a write that fails does not stop the answer", async () => {
    const onAuditError = vi.fn();
    const failing = registerCoreVerbs(
      new Broker({ root: ROOT, audit: { write: () => Promise.reject(new Error("disk full")) }, onAuditError }),
      system,
    );
    expect((await failing.handle({ id: "a", verb: "ping" })).ok).toBe(true);
    expect(onAuditError).toHaveBeenCalledOnce();
  });
});

describe("inProcessTransport", () => {
  it("hands a request to the broker through JSON", async () => {
    const response = await inProcessTransport(broker).call({ id: "t-1", verb: "ping" });
    expect(response).toEqual({ id: "t-1", ok: true, result: { ok: true, detail: "arashouse-broker 9.9.9" } });
  });
});
