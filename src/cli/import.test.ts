import { describe, expect, it } from "vitest";
import { KNOWN_ENGINES, splitImports } from "./import.js";

const GET = { holder: "value", wait: "value", json: "flag" } as const;

describe("splitImports", () => {
  it("gives each --import the options after it, and leaves the command's own in order", () => {
    const split = splitImports(
      ["23", "--import", "a.mf", "--merge", "--holder", "--merge", "--import=b", "--package", "P", "--package=Q", "--release", "R", "--json"],
      GET,
      "--import",
    );
    expect(split.rest).toEqual(["23", "--holder", "--merge", "--json"]);
    expect(split.steps).toEqual([
      { given: "a.mf", options: { merge: true }, packages: [] },
      { given: "b", options: { release: "R" }, packages: ["P", "Q"] },
    ]);
  });

  it("starts an import at each positional in the import command's form", () => {
    const split = splitImports(["--lease", "abc", "one", "--merge", "two", "--timeout=-1"], { lease: "value" }, "positional");
    expect(split.rest).toEqual(["--lease", "abc"]);
    expect(split.steps.map((s) => [s.given, s.options])).toEqual([
      ["one", { merge: true }],
      ["two", { timeout: "-1" }],
    ]);
  });

  it("refuses an import option with no import before it, one given twice, and a missing value", () => {
    expect(() => splitImports(["--merge", "--import", "a"], GET, "--import")).toThrow(/belongs to an import/);
    expect(() => splitImports(["--import", "a", "--release", "x", "--release", "y"], GET, "--import")).toThrow(/given twice/);
    expect(() => splitImports(["--import", "a", "--merge=yes"], GET, "--import")).toThrow(/takes no value/);
    expect(() => splitImports(["--import"], GET, "--import")).toThrow(/needs a value/);
    expect(() => splitImports(["--import", ""], GET, "--import")).toThrow(/needs a manifest/);
  });

  it("knows the three engines of the flavor registry", () => {
    expect([...KNOWN_ENGINES].sort()).toEqual(["12.0", "14.0.7", "14.35"]);
  });
});
