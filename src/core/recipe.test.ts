import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "./exit-codes.js";
import { LeaseError } from "./lease.js";
import { BOOTSTRAP_STEPS, RECIPE_NAME, parseRecipe, parseRecipeText, recipeFlavor } from "./recipe.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The recipe docs/bootstrap.md shows, as it is there: the first ```json block. */
async function documentedRecipe(): Promise<unknown> {
  const doc = await readFile(join(repoRoot, "docs", "bootstrap.md"), "utf8");
  const block = /```json\n([\s\S]*?)```/.exec(doc);
  expect(block).not.toBeNull();
  return JSON.parse(block![1]!);
}

function usage(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(LeaseError);
    expect((err as LeaseError).exitCode).toBe(EXIT_CODES.usage);
    return (err as Error).message;
  }
  throw new Error("expected a usage error");
}

describe("parseRecipe", () => {
  it("reads every section and fills the defaults: atomic, no git, no agent", () => {
    const recipe = parseRecipe(
      {
        flavor: "23",
        restore: "profiles/demo.bak",
        code: [{ from: "./overlay", to: "Innovator/Client" }, { from: "cfg.zip", to: ".", allow_config: true, allow_servers: true }],
        import: [{ manifest: "./pkgs/imports.mf", merge: true, release: "R1", packages: ["A", "B"], timeout: -1 }, { manifest: "./more", merge: false }],
      },
      "r.json",
    );
    expect(recipe).toEqual({
      flavor: "23",
      restore: { from: "profiles/demo.bak", allowForeignOrigin: false, skipVersionCheck: false },
      code: [
        { from: "./overlay", to: "Innovator/Client", allowConfig: false, allowServers: false },
        { from: "cfg.zip", to: ".", allowConfig: true, allowServers: true },
      ],
      import: [
        { manifest: "./pkgs/imports.mf", options: { merge: true, release: "R1", timeout: "-1" }, packages: ["A", "B"] },
        { manifest: "./more", options: { "no-merge": true }, packages: [] },
      ],
      git: false,
      agent: false,
      atomic: true,
    });
  });

  it("takes the restore as an object with its overrides, and the 14.35 import options by their recipe names", () => {
    const recipe = parseRecipe(
      {
        restore: { from: "x.bak", allow_foreign_origin: true, skip_version_check: true },
        import: [{ manifest: "m", languages: "*", collect_errors: true, batch: true, os_user: "me", description: "d", engine: "14.35", skip_version_check: true }],
        git: true,
        agent: true,
        atomic: false,
      },
      "r.json",
    );
    expect(recipe.restore).toEqual({ from: "x.bak", allowForeignOrigin: true, skipVersionCheck: true });
    expect(recipe.import[0]?.options).toEqual({ languages: "*", "collect-errors": true, batch: true, "os-user": "me", description: "d", engine: "14.35", "skip-version-check": true });
    expect(recipe).toMatchObject({ git: true, agent: true, atomic: false });
  });

  it("accepts an empty recipe: a lease with a health check only", () => {
    expect(parseRecipe({}, "r.json")).toEqual({ code: [], import: [], git: false, agent: false, atomic: true });
  });

  it("refuses a key that names a secret, at any depth, without quoting its value", () => {
    const planted = "hunter2-value";
    for (const [value, path] of [
      [{ password: planted }, "password"],
      [{ flavor: "23", token: planted }, "token"],
      [{ code: [{ from: "x", api_key: planted }] }, "code[0].api_key"],
      [{ import: [{ manifest: "m", secret: planted }] }, "import[0].secret"],
      [{ restore: { from: "x.bak", key: planted } }, "restore.key"],
      [{ licence_key: planted }, "licence_key"],
      [{ ARAS_PASSWORD: planted }, "ARAS_PASSWORD"],
    ] as const) {
      const message = usage(() => parseRecipe(value, "r.json"));
      expect(message, path).toContain(`recipe r.json: ${path} looks like a secret`);
      expect(message, path).not.toContain("hunter2-value");
    }
  });

  it("refuses an unknown key, a value of the wrong kind and a flavor it does not know", () => {
    for (const [value, expected] of [
      [[], /the recipe must be a JSON object/],
      [{ bootstrap: true }, /the recipe has no "bootstrap"/],
      [{ flavor: "28" }, /flavor must be one of 12sp9, 23, 35/],
      [{ restore: "" }, /restore must be a non-empty string/],
      [{ restore: { file: "x" } }, /restore has no "file"/],
      [{ code: { from: "x" } }, /code must be a list/],
      [{ code: [{ to: "Innovator" }] }, /code\[0\]\.from must be a non-empty string/],
      [{ code: [{ from: "x", mirror: true }] }, /code\[0\] has no "mirror"/],
      [{ import: [{ manifest: "m", merge: "yes" }] }, /import\[0\]\.merge must be true or false/],
      [{ import: [{ manifest: "m", timeout: 1.5 }] }, /import\[0\]\.timeout must be a whole number/],
      [{ import: [{ manifest: "m", packages: "A" }] }, /import\[0\]\.packages must be a list/],
      [{ git: "yes" }, /git must be true or false/],
      [{ atomic: 0 }, /atomic must be true or false/],
    ] as const) {
      expect(usage(() => parseRecipe(value, "r.json")), JSON.stringify(value)).toMatch(expected);
    }
  });

  it("names a recipe that is not JSON", () => {
    expect(usage(() => parseRecipeText("{ flavor: 23 }", "/x/r.json"))).toMatch(/^recipe \/x\/r\.json: not JSON/);
    expect(parseRecipeText('﻿{"flavor":"35"}', "r.json").flavor).toBe("35");
  });
});

describe("recipeFlavor", () => {
  it("takes the command's flavor or the recipe's, and refuses two that differ or none", () => {
    const of = (flavor?: "23") => parseRecipe(flavor === undefined ? {} : { flavor }, "r.json");
    expect(recipeFlavor(of("23"), undefined, "r.json")).toBe("23");
    expect(recipeFlavor(of(), "12sp9", "r.json")).toBe("12sp9");
    expect(recipeFlavor(of("23"), "23", "r.json")).toBe("23");
    expect(usage(() => recipeFlavor(of("23"), "35", "r.json"))).toBe("recipe r.json is for flavor 23, not 35");
    expect(usage(() => recipeFlavor(of(), undefined, "r.json"))).toMatch(/names no flavor/);
    expect(usage(() => recipeFlavor(of(), "28", "r.json"))).toMatch(/unknown flavor "28"/);
  });
});

describe("the recipe's documents", () => {
  it("runs the steps in the fixed order: restore, code, import, git, then the health check", () => {
    expect(BOOTSTRAP_STEPS).toEqual(["restore", "code", "import", "git", "health"]);
  });

  it("names recipes as files can be named, and nothing that leaves the recipes folder", () => {
    for (const name of ["demo", "r23.full", "a_b-c"]) expect(RECIPE_NAME.test(name), name).toBe(true);
    for (const name of ["", "../x", "a/b", ".hidden", "x".repeat(65)]) expect(RECIPE_NAME.test(name), name).toBe(false);
  });

  it("the worked example in docs/bootstrap.md parses, and it and the parser agree with docs/schemas/recipe.schema.json", async () => {
    const schema = JSON.parse(await readFile(join(repoRoot, "docs", "schemas", "recipe.schema.json"), "utf8")) as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const example = await documentedRecipe();
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(parseRecipe(example, "example.json")).toMatchObject({ flavor: "23", git: true, atomic: true });
    // What the schema refuses, the parser refuses too.
    for (const bad of [{ token: 1 }, { flavor: "28" }, { code: [{}] }, { import: [{ manifest: "m", timeout: -2 }] }, { extra: 1 }]) {
      expect(validate(bad), JSON.stringify(bad)).toBe(false);
      expect(() => parseRecipe(bad, "r.json"), JSON.stringify(bad)).toThrow(LeaseError);
    }
  });
});
