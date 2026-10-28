import { describe, expect, it } from "vitest";
import { UsageError } from "../core/lease.js";
import { parseArgs, parseSeconds, stringOption } from "./args.js";

describe("parseArgs", () => {
  const spec = { holder: "value", json: "flag", wait: "optional" } as const;

  it("reads positionals, flags and values in both forms", () => {
    const parsed = parseArgs(["23", "--holder", "task", "--json", "--wait=5"], spec);
    expect(parsed.positionals).toEqual(["23"]);
    expect(parsed.options).toEqual({ holder: "task", json: true, wait: "5" });
    expect(stringOption(parsed, "holder")).toBe("task");
    expect(parseArgs(["--holder=a=b"], spec).options.holder).toBe("a=b");
  });

  it("never lets an optional value swallow the next argument", () => {
    const parsed = parseArgs(["--wait", "0123"], spec);
    expect(parsed.options.wait).toBe(true);
    expect(parsed.positionals).toEqual(["0123"]);
  });

  it("stops at -- and keeps the rest untouched", () => {
    const parsed = parseArgs(["--holder", "x", "--", "cmd", "--json", "-h"], spec);
    expect(parsed.rest).toEqual(["cmd", "--json", "-h"]);
    expect(parsed.options).toEqual({ holder: "x" });
    expect(parseArgs(["a"], spec).rest).toBeUndefined();
  });

  it("collects a list option given more than once, in order", () => {
    const list = { code: "list", json: "flag" } as const;
    const parsed = parseArgs(["--code", "a", "--json", "--code=b:Innovator"], list);
    expect(parsed.lists).toEqual({ code: ["a", "b:Innovator"] });
    expect(parsed.options).toEqual({ json: true });
    expect(parseArgs([], list).lists).toEqual({});
    for (const args of [["--code"], ["--code", "--"], ["--code="]]) expect(() => parseArgs(args, list), args.join(" ")).toThrow(UsageError);
  });

  it("refuses unknown, repeated, missing and misplaced values", () => {
    for (const args of [["--nope"], ["-x"], ["--json", "--json"], ["--holder"], ["--holder", "--"], ["--json=1"]]) {
      expect(() => parseArgs(args, spec), args.join(" ")).toThrow(UsageError);
    }
  });
});

describe("parseSeconds", () => {
  it("takes 0 or more seconds", () => {
    expect(parseSeconds("0", "--wait")).toBe(0);
    expect(parseSeconds("2.5", "--wait")).toBe(2.5);
    for (const bad of ["", "-1", "soon", "1e3", "Infinity"]) expect(() => parseSeconds(bad, "--wait")).toThrow(UsageError);
  });
});
