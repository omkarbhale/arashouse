import { describe, expect, it } from "vitest";
import { BUILD_PASSWORDS, sampleGolden } from "./config-samples.fixture.js";
import { editList } from "./edit-lists.js";
import {
  type Edit,
  type EditList,
  type EditSecrets,
  EDIT_LIST_SCHEMA,
  EditError,
  editListFiles,
  editVars,
  formatEditOutcomes,
  innovatorServerUrl,
  parseEditList,
  renderFile,
  secretsNeeded,
  serializeEditList,
  verifyFile,
} from "./edits.js";
import { FLAVOR_KEYS, type FlavorKey } from "./flavors.js";
import { buildNames, slotNames } from "./names.js";
import { Secret } from "./secret.js";

// Values are assembled at run time so no secret-shaped literal sits in the source.
const LICENCE = ["LK", "-", "51E7", "-", "A0", "&", "Q9", "<", "Z"].join("");
const DBO = ["db", "o", "-", "Pw7", "Xq2", "Lm"].join("");
const REG = ["re", "g", "-", "Hn4", "Tz8", "Vc"].join("");
const SECRET_STRINGS = [LICENCE, DBO, REG];

const secrets: EditSecrets = {
  licence: Secret.of(LICENCE, "licence"),
  db_dbo_password: Secret.of(DBO, "sql-login"),
  db_reg_password: Secret.of(REG, "sql-login"),
};

const enc = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const dec = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

function holdsNoSecret(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const s of SECRET_STRINGS) expect(text).not.toContain(s);
  expect(text).not.toContain(BUILD_PASSWORDS.dbo);
  expect(text).not.toContain(BUILD_PASSWORDS.reg);
}

const list = (flavor: FlavorKey, edits: readonly Edit[]): EditList => parseEditList({ schema: EDIT_LIST_SCHEMA, flavor, edits });

describe.each(FLAVOR_KEYS)("the %s edit list on sample golden configs", (flavor) => {
  const golden = sampleGolden(flavor);
  const edits = editList(flavor);
  const ref = { flavor, slot: 2 };
  const vars = editVars(ref);
  const names = slotNames(ref);
  const build = buildNames(flavor);

  it("edits exactly the sample files", () => {
    expect(editListFiles(edits).map((f) => f.toLowerCase()).sort()).toEqual(Object.keys(golden).map((f) => f.toLowerCase()).sort());
    expect(editListFiles(edits)).toHaveLength(flavor === "35" ? 6 : 8);
  });

  it.each(Object.keys(golden))("applies every edit to %s, then finds them all already applied", (file) => {
    const bytes = enc(golden[file] ?? "");
    const first = renderFile(file, bytes, edits, vars, secrets);
    expect(first.changed).toBe(true);
    expect(first.outcomes.length).toBeGreaterThan(0);
    for (const o of first.outcomes) expect(o.status).toBe("applied");

    const second = renderFile(file, first.bytes, edits, vars, secrets);
    expect(second.changed).toBe(false);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    for (const o of second.outcomes) expect(o.status).toBe("already");

    expect(verifyFile(file, first.bytes, edits, vars, secrets).ok).toBe(true);
    const stale = verifyFile(file, bytes, edits, vars, secrets);
    expect(stale.ok).toBe(false);
    expect(stale.outcomes.every((o) => o.status === "differs")).toBe(true);
  });

  it("leaves no build name, build password or build path anywhere, and keeps the line structure", () => {
    for (const [file, text] of Object.entries(golden)) {
      const out = dec(renderFile(file, enc(text), edits, vars, secrets).bytes);
      for (const stale of [build.alias, build.database, build.dir, `:${build.agentPort}/`, BUILD_PASSWORDS.dbo, BUILD_PASSWORDS.reg]) {
        expect(out).not.toContain(stale);
      }
      expect(out.split("\r\n")).toHaveLength(text.split("\r\n").length);
      expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    }
  });

  it("writes the slot's names, paths and secrets where the measured configs hold them", () => {
    const render = (file: string) => dec(renderFile(file, enc(golden[file] ?? ""), edits, vars, secrets).bytes);
    const server = render("InnovatorServerConfig.xml");
    expect(server).toContain(
      `<DB-Connection id="${names.database}" database="${names.database}" server="(local)" regular_uid="${names.logins.reg}" regular_pwd="${REG}" dbo_uid="${names.logins.dbo}" dbo_pwd="${DBO}"/>`,
    );
    // The licence value holds '&' and '<', which the attribute carries escaped.
    expect(server).toContain(`lic_key="${LICENCE.replace("&", "&amp;").replace("<", "&lt;")}" act_key=""`);
    expect(server).toContain(`<operating_parameter key="temp_folder" value="${names.slotDir}\\Innovator\\Server\\temp\\" />`);
    expect(server).toContain(`<operating_parameter key="debug_log_prefix" value="${names.slotDir}\\Innovator\\Server\\logs\\" />`);
    expect(server).toContain(`InnovatorToServiceAddress="http://localhost:${names.agentPort}/`);
    expect(render("Innovator/Server/Innovator.xml")).toContain(`<ConfigFilePath value="${names.slotDir}\\InnovatorServerConfig.xml">`);
    const oauth = render("OAuthServer/OAuth.config");
    expect(oauth.split(`/${names.alias}/Client/OAuth/`)).toHaveLength(21);
    expect(render("OAuthServer/OAuthServer.config")).toContain(`value="${innovatorServerUrl(names.alias)}"`);
    expect(render("VaultServer/vault.config")).toContain(`<add key="LocalPath" value="${names.vaultDir}\\"></add>`);
    if (flavor !== "35") {
      expect(render("SelfServiceReportConfig.xml")).toContain(
        `Initial Catalog=${names.database};Persist Security Info=True;Pooling=False;User ID=${names.logins.reg};Password=${REG};" name="${names.database}" />`,
      );
      expect(render("SelfServiceReporting/SelfServiceReport.xml")).toContain(`value="${names.slotDir}\\SelfServiceReportConfig.xml"`);
    }
  });

  it("reports every edit without a secret's value", () => {
    for (const [file, text] of Object.entries(golden)) {
      const { outcomes } = renderFile(file, enc(text), edits, vars, secrets);
      holdsNoSecret(outcomes);
      holdsNoSecret(formatEditOutcomes(outcomes));
    }
    const { outcomes } = renderFile("InnovatorServerConfig.xml", enc(golden["InnovatorServerConfig.xml"] ?? ""), edits, vars, secrets);
    expect(outcomes.find((o) => o.path.endsWith("@lic_key"))?.value).toBe("[redacted]");
    expect(outcomes.find((o) => o.path.endsWith("@database"))?.value).toBe(names.database);
    expect(formatEditOutcomes(outcomes)).toContain(
      `applied InnovatorServerConfig.xml /Innovator/DB-Connection/@dbo_pwd (1) = [redacted]`,
    );
  });

  it("needs the licence and both SQL login passwords", () => {
    expect(secretsNeeded(edits).sort()).toEqual(["db_dbo_password", "db_reg_password", "licence"]);
  });

  it("round-trips through edits.json", () => {
    expect(parseEditList(serializeEditList(edits))).toEqual(edits);
  });
});

describe("byte preservation", () => {
  const file = "a.xml";
  const one = list("23", [{ file, kind: "xml", path: "/r/x/@v", value: "{{alias}}" }]);
  const vars = editVars({ flavor: "23", slot: 1 });

  it("changes only the value's characters: quotes, spacing, comments and attribute order stay", () => {
    const text = "<?xml version='1.0'?>\r\n<!-- <x v=\"no\"/> -->\r\n<r>\r\n  <x  b = 'k'   v = 'old' a=\"1\" />\r\n</r>";
    const out = dec(renderFile(file, enc(text), one, vars, {}).bytes);
    expect(out).toBe(text.replace("'old'", "'ah-23-01'"));
  });

  it("keeps a UTF-8 BOM, UTF-16 with its BOM, and non-ASCII text", () => {
    const text = '<r>\n<!-- é ✓ -->\n<x v="old"/></r>\n';
    const expected = text.replace('"old"', '"ah-23-01"');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text, "utf8")]);
    const out = renderFile(file, bom, one, vars, {}).bytes;
    expect(Buffer.from(out).equals(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from(expected, "utf8")]))).toBe(true);

    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from(text, "utf16le")]);
    const out16 = renderFile(file, utf16, one, vars, {}).bytes;
    expect(Buffer.from(out16).equals(Buffer.from([0xff, 0xfe, ...Buffer.from(expected, "utf16le")]))).toBe(true);
  });

  it("returns the input bytes untouched when nothing changes", () => {
    const bytes = enc('<r><x v="ah-23-01"/></r>');
    const result = renderFile(file, bytes, one, vars, {});
    expect(result.changed).toBe(false);
    expect(result.bytes).toBe(bytes);
  });

  it("escapes a value for its quotes and compares decoded values, so it stays idempotent", () => {
    const quoted = list("23", [{ file, kind: "xml", path: "/r/x/@v", value: `a&b"c'd<e` }]);
    const out = renderFile(file, enc(`<r><x v='old'/></r>`), quoted, vars, {});
    expect(dec(out.bytes)).toBe(`<r><x v='a&amp;b"c&apos;d&lt;e'/></r>`);
    expect(renderFile(file, out.bytes, quoted, vars, {}).outcomes[0]?.status).toBe("already");
  });

  it("edits text() and a JSON string, keeping comments and layout", () => {
    const t = list("23", [{ file, kind: "xml", path: "//name/text()", value: "{{database}}" }]);
    expect(dec(renderFile(file, enc("<r>\n  <name> old </name>\n</r>"), t, vars, {}).bytes)).toBe(
      "<r>\n  <name>arashouse_23_01</name>\n</r>",
    );
    const j = list("23", [{ file: "appsettings.json", kind: "json", path: "/Server/Url", value: "{{serverUrl}}" }]);
    const json = '{\r\n  // the server\r\n  "Server": { "Url": "http://x/", "Port": 80 },\r\n  "Url": "keep"\r\n}\r\n';
    const out = renderFile("appsettings.json", enc(json), j, vars, {});
    expect(dec(out.bytes)).toBe(json.replace('"http://x/"', `"${innovatorServerUrl("ah-23-01")}"`));
    expect(renderFile("appsettings.json", out.bytes, j, vars, {}).outcomes[0]?.status).toBe("already");
  });
});

describe("refusals", () => {
  const vars = editVars({ flavor: "12sp9", slot: 1 });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(EditError);
      return (err as EditError).code;
    }
    throw new Error("did not throw");
  };

  it("refuses a selector that matches nothing or more than once, unless it is marked many", () => {
    const db = (many?: boolean) =>
      list("12sp9", [{ file: "c.xml", kind: "xml", path: "/Innovator/DB-Connection/@database", value: "{{database}}", ...(many ? { many } : {}) }]);
    const two = enc('<Innovator><DB-Connection database="a"/><DB-Connection database="b"/></Innovator>');
    expect(code(() => renderFile("c.xml", two, db(), vars, {}))).toBe("ambiguous");
    expect(code(() => renderFile("c.xml", enc("<Innovator><Other/></Innovator>"), db(), vars, {}))).toBe("not-found");
    // An element without the attribute is not a match.
    expect(code(() => renderFile("c.xml", enc("<Innovator><DB-Connection id='a'/></Innovator>"), db(), vars, {}))).toBe("not-found");
    const many = renderFile("c.xml", two, db(true), vars, {});
    expect(many.outcomes[0]).toMatchObject({ status: "applied", matches: 2 });
    expect(dec(many.bytes).split("arashouse_12sp9_01")).toHaveLength(3);

    const text = (n: number, many?: boolean) =>
      renderFile("t.txt", enc("x/ah-build-12sp9/y ".repeat(n)), list("12sp9", [{ file: "t.txt", kind: "text", path: "/{{build.alias}}/", value: "/{{alias}}/", ...(many ? { many } : {}) }]), vars, {});
    expect(code(() => text(2))).toBe("ambiguous");
    expect(code(() => text(0))).toBe("not-found");
    expect(text(2, true).outcomes[0]).toMatchObject({ status: "applied", matches: 2 });
  });

  it("refuses a text edit whose replacement contains the text it replaces", () => {
    const l = list("12sp9", [{ file: "t.txt", kind: "text", path: "ah-", value: "{{alias}}" }]);
    expect(code(() => renderFile("t.txt", enc("ah-x"), l, vars, {}))).toBe("not-idempotent");
  });

  it("refuses a missing secret, or one of the wrong kind, and names only the handle", () => {
    const l = list("12sp9", [{ file: "c.xml", kind: "xml", path: "/r/@k", value: "{{secret:licence}}" }]);
    const bytes = enc("<r k=''/>");
    expect(code(() => renderFile("c.xml", bytes, l, vars, {}))).toBe("secret-missing");
    const wrong = { licence: Secret.of(DBO, "sql-login") };
    expect(code(() => renderFile("c.xml", bytes, l, vars, wrong))).toBe("secret-missing");
    try {
      renderFile("c.xml", bytes, l, vars, wrong);
    } catch (err) {
      holdsNoSecret((err as Error).message);
      expect((err as Error).message).toMatch(/licence/);
    }
  });

  it("refuses malformed XML, JSON and an undecodable file", () => {
    const x = list("12sp9", [{ file: "c.xml", kind: "xml", path: "/r/@k", value: "v" }]);
    expect(code(() => renderFile("c.xml", enc("<r k='a'><s></r>"), x, vars, {}))).toBe("malformed");
    expect(code(() => renderFile("c.xml", new Uint8Array([0x3c, 0xc3, 0x28, 0x3e]), x, vars, {}))).toBe("encoding");
    const j = list("12sp9", [{ file: "a.json", kind: "json", path: "/a", value: "v" }]);
    expect(code(() => renderFile("a.json", enc('{"a": "x",}'), j, vars, {}))).toBe("malformed");
    expect(code(() => renderFile("a.json", enc('{"a": 1}'), j, vars, {}))).toBe("selector");
  });

  it("refuses a file the list does not edit", () => {
    expect(code(() => renderFile("other.xml", enc("<r/>"), editList("12sp9"), vars, secrets))).toBe("invalid");
  });

  it("matches the file name case-insensitively, as Windows does", () => {
    const golden = sampleGolden("23")["Innovator/Client/Innovator.xml"] ?? "";
    const out = renderFile("Innovator\\Client\\innovator.xml", enc(golden), editList("23"), editVars({ flavor: "23", slot: 1 }), {});
    expect(out.outcomes).toHaveLength(1);
  });
});

describe("verify", () => {
  const ref = { flavor: "12sp9", slot: 1 } as const;
  const vars = editVars(ref);
  const edits = editList("12sp9");
  const golden = sampleGolden("12sp9")["InnovatorServerConfig.xml"] ?? "";
  const rendered = renderFile("InnovatorServerConfig.xml", enc(golden), edits, vars, secrets).bytes;

  it("names the edit that no longer holds, without its value", () => {
    const tampered = enc(dec(rendered).replace(`dbo_pwd="${DBO}"`, 'dbo_pwd="changed-by-hand"'));
    const result = verifyFile("InnovatorServerConfig.xml", tampered, edits, vars, secrets);
    expect(result.ok).toBe(false);
    expect(result.outcomes.filter((o) => o.status !== "ok")).toEqual([
      expect.objectContaining({ path: "/Innovator/DB-Connection/@dbo_pwd", status: "differs" }),
    ]);
    holdsNoSecret(result);
    expect(JSON.stringify(result)).not.toContain("changed-by-hand");
  });

  it("reports a missing secret or an unparseable file as an error, never throwing", () => {
    const noSecrets = verifyFile("InnovatorServerConfig.xml", rendered, edits, vars, {});
    expect(noSecrets.ok).toBe(false);
    expect(noSecrets.outcomes.filter((o) => o.status === "error").map((o) => o.path).sort()).toEqual([
      "/Innovator/DB-Connection/@dbo_pwd",
      "/Innovator/DB-Connection/@regular_pwd",
      "/Innovator/License/@lic_key",
    ]);
    const broken = verifyFile("InnovatorServerConfig.xml", enc("<Innovator>"), edits, vars, secrets);
    expect(broken.ok).toBe(false);
    // The XML edits cannot read the file; the agent-port text edit finds nothing to check.
    for (const o of broken.outcomes) expect(o.status).toBe(o.kind === "xml" ? "error" : "differs");
  });
});

describe("parseEditList", () => {
  const edit: Edit = { file: "a.xml", kind: "xml", path: "/r/@v", value: "{{alias}}" };
  const bad = (edits: unknown[], extra: Record<string, unknown> = {}) => () =>
    parseEditList({ schema: EDIT_LIST_SCHEMA, flavor: "23", edits, ...extra });

  it("accepts a valid list and keeps many only when true", () => {
    expect(parseEditList({ schema: 1, flavor: "23", edits: [{ ...edit, many: false }] }).edits[0]).toEqual(edit);
  });

  it.each([
    ["an unknown variable", [{ ...edit, value: "{{nope}}" }], /unknown template variable/],
    ["a secret in a path", [{ ...edit, kind: "text", path: "{{secret:licence}}" }], /only in an edit's value/],
    ["an unknown secret handle", [{ ...edit, value: "{{secret:sa}}" }], /unknown secret handle/],
    ["a stray brace", [{ ...edit, value: "{{alias}" }], /stray/],
    ["a path outside the tree", [{ ...edit, file: "../x.xml" }], /unsafe edit file/],
    ["a backslash path", [{ ...edit, file: "a\\b.xml" }], /unsafe edit file/],
    ["an absolute path", [{ ...edit, file: "C:/x.xml" }], /unsafe edit file/],
    ["an unknown kind", [{ ...edit, kind: "ini" }], /kind/],
    ["a bad selector", [{ ...edit, path: "/r/v" }], /bad XML selector/],
    ["a bad pointer", [{ ...edit, kind: "json", path: "a" }], /bad JSON pointer/],
    ["an unknown field", [{ ...edit, extra: 1 }], /unknown field/],
    ["a duplicate", [edit, { ...edit, file: "A.xml" }], /edited twice/],
    ["no edits", [], /no edits/],
  ])("refuses %s", (_name, edits, message) => {
    expect(bad(edits)).toThrow(message);
  });

  it("refuses a wrong schema, an unknown flavor and non-JSON", () => {
    expect(bad([edit], { schema: 2 })).toThrow(/schema/);
    expect(bad([edit], { flavor: "olm" })).toThrow(/flavor/);
    expect(() => parseEditList("{")).toThrow(/not JSON/);
  });
});
