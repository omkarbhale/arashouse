import { describe, expect, it } from "vitest";
import { HOST_METHODS } from "../host/driver.js";
import {
  DEFAULT_VERB_TIMEOUT_MS,
  ProtocolError,
  encodeLine,
  parseRequest,
  parseResponse,
  parseSlotStamp,
  requestIdOf,
  targetOf,
  verbTimeout,
} from "./protocol.js";

const slot = { flavor: "12sp9", slot: 1 } as const;
const stamp = { slotId: "12sp9-01", flavor: "12sp9", goldenHash: "abc", lastResetAt: "2026-10-27T00:00:00.000Z" };

describe("parseRequest", () => {
  it("accepts a verb with no target, a slot or a flavor, and args", () => {
    expect(parseRequest({ id: "r-1", verb: "ping" })).toEqual({ id: "r-1", verb: "ping" });
    expect(parseRequest({ id: "r-1", verb: "readStamp", slot })).toEqual({ id: "r-1", verb: "readStamp", slot });
    expect(parseRequest({ id: "r-1", verb: "baselineVerify", flavor: "23", args: { level: "fast" } })).toEqual({
      id: "r-1",
      verb: "baselineVerify",
      flavor: "23",
      args: { level: "fast" },
    });
  });

  it("knows exactly the host-driver methods as verbs", () => {
    for (const verb of HOST_METHODS) expect(parseRequest({ id: "a", verb }).verb).toBe(verb);
    for (const verb of ["run", "exec", "sql", "shell", "constructor", "__proto__", "", 1]) {
      expect(() => parseRequest({ id: "a", verb })).toThrow(/not one of the broker's verbs/);
    }
  });

  it.each([
    [null, /JSON object/],
    [[], /JSON object/],
    [{ id: "a", verb: "ping", command: "whoami" }, /no "command" field/],
    [{ id: "a", verb: "ping", path: "C:\\x" }, /no "path" field/],
    [{ id: "", verb: "ping" }, /request id/],
    [{ id: "a b", verb: "ping" }, /request id/],
    [{ id: "x".repeat(65), verb: "ping" }, /request id/],
    [{ id: "a", verb: "readStamp", slot, flavor: "23" }, /not both/],
    [{ id: "a", verb: "readStamp", slot: { flavor: "12sp9", slot: 1, root: "D:\\" } }, /slot is \{ flavor, slot \}/],
    [{ id: "a", verb: "readStamp", slot: { flavor: "12sp9", slot: "01" } }, /slot is \{ flavor, slot \}/],
    [{ id: "a", verb: "readStamp", slot: "12sp9-01" }, /slot is \{ flavor, slot \}/],
    [{ id: "a", verb: "baselineVerify", flavor: 23 }, /flavor is a string/],
    [{ id: "a", verb: "ping", args: ["x"] }, /args is a JSON object/],
  ])("refuses %j", (value, message) => {
    expect(() => parseRequest(value)).toThrow(ProtocolError);
    expect(() => parseRequest(value)).toThrow(message);
  });

  it("finds the id of a malformed request when it has a valid one", () => {
    expect(requestIdOf({ id: "r-9", verb: "nope" })).toBe("r-9");
    expect(requestIdOf({ id: "a b" })).toBe("");
    expect(requestIdOf("x")).toBe("");
  });
});

describe("targetOf", () => {
  it("is the slot id or flavor when valid, else null", () => {
    expect(targetOf({ slot })).toBe("12sp9-01");
    expect(targetOf({ flavor: "35" })).toBe("35");
    expect(targetOf({ slot: { flavor: "OLM_Local" as never, slot: 1 } })).toBeNull();
    expect(targetOf({ flavor: "prod" as never })).toBeNull();
    expect(targetOf({})).toBeNull();
  });
});

describe("parseResponse", () => {
  it("accepts a result or an error of a known kind for the expected id", () => {
    expect(parseResponse({ id: "a", ok: true, result: { ok: true, detail: "d", x: 1 } }, "a")).toEqual({
      id: "a",
      ok: true,
      result: { ok: true, detail: "d", x: 1 },
    });
    expect(parseResponse({ id: "a", ok: false, error: { kind: "Refused", message: "m" } }, "a")).toEqual({
      id: "a",
      ok: false,
      error: { kind: "Refused", message: "m" },
    });
  });

  it.each([
    [{ id: "b", ok: true, result: { ok: true, detail: "d" } }, /different request/],
    [{ id: "a", ok: true, result: { ok: "yes", detail: "d" } }, /ok and detail/],
    [{ id: "a", ok: true }, /ok and detail/],
    [{ id: "a", ok: false, error: { kind: "Boom", message: "m" } }, /known kind/],
    [{ id: "a" }, /ok: true or ok: false/],
    ["a", /JSON object/],
  ])("refuses %j", (value, message) => {
    expect(() => parseResponse(value, "a")).toThrow(message);
  });
});

describe("encodeLine", () => {
  it("is one JSON line within the limit, else a ProtocolError", () => {
    expect(encodeLine({ a: "b\nc" }, 100)).toBe('{"a":"b\\nc"}\n');
    expect(() => encodeLine({ a: "x".repeat(100) }, 50)).toThrow(/larger than 50 bytes/);
  });
});

describe("verbTimeout", () => {
  it("bounds the quick verbs tighter than the default", () => {
    expect(verbTimeout("ping")).toBeLessThan(DEFAULT_VERB_TIMEOUT_MS);
    expect(verbTimeout("restoreDatabase")).toBeGreaterThan(DEFAULT_VERB_TIMEOUT_MS);
    expect(verbTimeout("deployCode")).toBeGreaterThan(DEFAULT_VERB_TIMEOUT_MS);
    expect(verbTimeout("healthCheck")).toBeGreaterThan(DEFAULT_VERB_TIMEOUT_MS);
    expect(verbTimeout("resetDatabase")).toBeGreaterThan(DEFAULT_VERB_TIMEOUT_MS);
  });
});

describe("parseSlotStamp", () => {
  it("accepts the slot's own stamp, with or without a lease id", () => {
    expect(parseSlotStamp(stamp, slot)).toEqual(stamp);
    expect(parseSlotStamp({ ...stamp, leaseId: null }, slot)).toEqual({ ...stamp, leaseId: null });
    expect(parseSlotStamp({ ...stamp, goldenHash: null, lastResetAt: null, extra: 1 }, slot)).toEqual({
      ...stamp,
      goldenHash: null,
      lastResetAt: null,
    });
  });

  it.each([
    [{ ...stamp, slotId: "12sp9-02" }, /names 12sp9-02, not 12sp9-01/],
    [{ ...stamp, flavor: "23" }, /flavor is 23, not 12sp9/],
    [{ ...stamp, slotId: "OLM_Local" }, /not <flavor>-<NN>/],
    [{ ...stamp, goldenHash: 5 }, /strings or null/],
    [{ ...stamp, leaseId: 5 }, /leaseId/],
    [{ flavor: "12sp9" }, /slotId and flavor/],
  ])("refuses %j", (value, message) => {
    expect(() => parseSlotStamp(value, slot)).toThrow(message);
  });
});
