import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

/**
 * Where `reveal` (the one way to read a Secret) may appear in non-test source, and how many times.
 * Adding a call site fails this test; the fix is to add the file here, in the same PR that needs it,
 * where a reviewer sees it. The host-side DPAPI store (ticket 21) and the lease-file writer
 * (ticket 34) are the expected additions.
 */
const ALLOWED: Readonly<Record<string, number>> = {
  // The definition of Secret.reveal itself.
  "src/core/secret.ts": 1,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name) ? [path] : [];
  });
}

/** Source with comments removed, so a mention of `reveal()` in prose is not a call site. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

export function countReveals(text: string): number {
  return stripComments(text).match(/\breveal\b/g)?.length ?? 0;
}

describe("Secret.reveal() call sites", () => {
  const found = sourceFiles(join(repoRoot, "src"))
    .map((file) => ({ path: relative(repoRoot, file).replaceAll("\\", "/"), count: countReveals(readFileSync(file, "utf8")) }))
    .filter((f) => f.count > 0);

  it("appear only in the allowlisted files, as many times as the allowlist says", () => {
    expect(Object.fromEntries(found.map((f) => [f.path, f.count]))).toEqual(ALLOWED);
  });
});

describe("the call-site counter", () => {
  it("counts calls, property reads and bracket access, but not comments", () => {
    expect(countReveals("secret.reveal()")).toBe(1);
    expect(countReveals("const f = s.reveal; f()")).toBe(1);
    expect(countReveals('s["reveal"]()')).toBe(1);
    expect(countReveals("a?.reveal?.()")).toBe(1);
    expect(countReveals("// reveal() is allowed here\n/* reveal() */ x")).toBe(0);
    expect(countReveals("const url = 'http://x'; s.reveal()")).toBe(1);
  });

  it("does not count other words", () => {
    expect(countReveals("revealed unrevealed")).toBe(0);
  });
});
