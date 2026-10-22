import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEDIA_ENV, type MediaCheckOptions, type MsiProperties } from "../core/index.js";
import { runMediaCheck } from "./media.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arashouse-cli-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const names23 = ["ProductCode", "WEBALIAS", "INSTALL_DATABASE", "SQL_ADO_CONN_DRIVER"];
const names12 = ["ProductCode", "WEBALIAS", "INSTALL_DATABASE", "LICENSEKEY"];

function props(version: string, names: string[]): MsiProperties {
  return { productName: "Aras Innovator", manufacturer: "Aras Corporation", productVersion: version, names };
}

function setup(): MediaCheckOptions {
  for (const [flavor, files] of [
    ["12sp9", ["InnovatorSetup.msi", "Core120.bak", "CoreAndSolutions120.bak"]],
    ["23", ["InnovatorSetup.msi", "Core140.bak", "CoreAndSolutions140.bak"]],
  ] as const) {
    mkdirSync(join(root, flavor), { recursive: true });
    for (const f of files) writeFileSync(join(root, flavor, f), `${flavor} ${f}`);
  }
  return {
    env: { [MEDIA_ENV]: root },
    startDir: root,
    readMsi: async (path) => (path.includes(`${join(root, "12sp9")}`) ? props("12.0.0", names12) : props("14.0.9", names23)),
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("arashouse media check", () => {
  it("checks every flavor by default, exits 1 when one is missing, and names it", async () => {
    const c = capture();
    const code = await runMediaCheck([], setup(), c.io);
    const text = c.out.join("\n");
    expect(code).toBe(1);
    expect(text).toMatch(/^12sp9: OK/m);
    expect(text).toMatch(/^23: OK/m);
    expect(text).toMatch(/^35: PROBLEMS/m);
    expect(text).toContain(`missing: ${join(root, "35", "InnovatorSetup.msi")}`);
    expect(text).toContain("does not distinguish");
  });

  it("exits 0 for flavors that are fine, and lists property names only", async () => {
    const c = capture();
    const code = await runMediaCheck(["23"], setup(), c.io);
    expect(code).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("MSI public properties (3), names only:");
    expect(text).toContain("INSTALL_DATABASE SQL_ADO_CONN_DRIVER WEBALIAS");
    expect(text).toContain("ProductVersion 14.0.9");
  });

  it("with two flavors, also lists the names present in one MSI and not the other", async () => {
    const c = capture();
    expect(await runMediaCheck(["12sp9", "23"], setup(), c.io)).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("property names 12sp9 vs 23:");
    expect(text).toContain("only in 12sp9 (1): LICENSEKEY");
    expect(text).toContain("only in 23 (1): SQL_ADO_CONN_DRIVER");
  });

  it("prints JSON with --json, including the diff for two flavors", async () => {
    const c = capture();
    const code = await runMediaCheck(["12sp9", "23", "--json"], setup(), c.io);
    expect(code).toBe(0);
    const body = JSON.parse(c.out.join("\n")) as {
      ok: boolean;
      flavors: { flavor: string; msi: { productVersion: string } }[];
      propertyDiff: { a: string; b: string; onlyInA: string[]; onlyInB: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.flavors.map((f) => [f.flavor, f.msi.productVersion])).toEqual([
      ["12sp9", "12.0.0"],
      ["23", "14.0.9"],
    ]);
    expect(body.propertyDiff).toEqual({ a: "12sp9", b: "23", onlyInA: ["LICENSEKEY"], onlyInB: ["SQL_ADO_CONN_DRIVER"] });
  });

  it("writes SHA256SUMS with --write-sums and then verifies against it", async () => {
    const options = setup();
    const c = capture();
    expect(await runMediaCheck(["23", "--write-sums"], options, c.io)).toBe(0);
    expect(readFileSync(join(root, "23", "SHA256SUMS"), "utf8").trim().split("\n")).toHaveLength(3);
    expect(c.out.join("\n")).toMatch(/checksums: verified \(3 of 3 ok\)/);
    const again = capture();
    expect(await runMediaCheck(["23", "--write-sums"], options, again.io)).toBe(1);
    expect(again.err.join("\n")).toMatch(/already exists/);
  });

  it("rejects an unknown flavor or option with usage and exit 2", async () => {
    for (const bad of [["28"], ["--nope"]]) {
      const c = capture();
      expect(await runMediaCheck(bad, setup(), c.io)).toBe(2);
      expect(c.err.join("\n")).toMatch(/usage: arashouse media check/);
      expect(c.out).toEqual([]);
    }
  });
});
