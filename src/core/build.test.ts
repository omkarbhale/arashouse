import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildId, readBuildInfo } from "./build.js";

const dir = mkdtempSync(join(tmpdir(), "arashouse-build-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the build identity", () => {
  const write = (name: string, value: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };

  it("reads dist/build.json and names the build by its commit", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const info = readBuildInfo(write("clean.json", { commit, dirty: false, built_at: "2026-11-26T10:00:00.000Z" }));
    expect(info).toEqual({ commit, dirty: false, built_at: "2026-11-26T10:00:00.000Z" });
    expect(buildId(info)).toBe("0123456789ab");
    expect(buildId(readBuildInfo(write("dirty.json", { commit, dirty: true, built_at: "x" })))).toBe("0123456789ab-dirty");
    expect(buildId(readBuildInfo(write("unknown.json", { commit: "unknown", dirty: false, built_at: "x" })))).toBe("unknown");
  });

  it("is none from source, and for a file that is not a build file", () => {
    expect(readBuildInfo(join(dir, "absent.json"))).toBeNull();
    expect(readBuildInfo(write("text.json", "{"))).toBeNull();
    expect(readBuildInfo(write("short.json", { commit: "abc", dirty: false, built_at: "x" }))).toBeNull();
    expect(buildId(null)).toBeNull();
  });
});
