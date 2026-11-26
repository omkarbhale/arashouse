import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertRunnable, windowsBatchScript } from "./run.js";

describe("a program run starts", () => {
  it("is never refused off Windows", () => {
    expect(() => assertRunnable("tool.cmd", {}, "linux")).not.toThrow();
  });

  it("on Windows, a .cmd or .bat named as such is refused with how to run it", () => {
    expect(() => assertRunnable("C:\\tools\\aras-pkg.cmd", {}, "win32")).toThrow(/batch script .*cmd\.exe.*node <its \.js>/);
    expect(() => assertRunnable("setup.BAT", {}, "win32")).toThrow(/batch script/);
    expect(() => assertRunnable("node.exe", {}, "win32")).not.toThrow();
  });
});

// The PATH search reads Windows paths, so it runs on Windows only.
describe.skipIf(process.platform !== "win32")("the PATH search for a bare name (Windows)", () => {
  const dir = mkdtempSync(join(tmpdir(), "arashouse-run-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const first = join(dir, "first");
  const second = join(dir, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "shim.cmd"), "@echo off\r\n");
  writeFileSync(join(second, "shim.exe"), "");
  writeFileSync(join(second, "both.exe"), "");
  writeFileSync(join(second, "both.cmd"), "@echo off\r\n");

  it("finds what cmd.exe would: the first folder, then PATHEXT's order", () => {
    const env = { Path: `${first};${second}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(windowsBatchScript("shim", env)).toBe(join(first, "shim.cmd"));
    expect(windowsBatchScript("both", env)).toBeUndefined();
    expect(windowsBatchScript("nothing-by-this-name", env)).toBeUndefined();
  });
});
