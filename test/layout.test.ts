import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  type: string;
  engines: { node: string };
  bin: Record<string, string>;
};

describe("package layout", () => {
  it("is an ES module package for Node 20 or newer", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=20");
  });

  it("declares the two bins, built from src/cli and src/broker", () => {
    expect(pkg.bin).toEqual({
      arashouse: "dist/cli/index.js",
      "arashouse-broker": "dist/broker/index.js",
    });
    expect(existsSync(join(repoRoot, "src/cli/index.ts"))).toBe(true);
    expect(existsSync(join(repoRoot, "src/broker/index.ts"))).toBe(true);
  });

  it.each(["src/core", "src/host", "src/broker", "src/cli", "spike", "docs", "test", "media/README.md", "AGENTS.md"])(
    "has %s",
    (path) => {
      expect(existsSync(join(repoRoot, path))).toBe(true);
    },
  );
});
