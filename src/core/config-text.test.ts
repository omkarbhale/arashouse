import { describe, expect, it } from "vitest";
import {
  ConfigTextError,
  decodeText,
  encodeText,
  parseJsonPointer,
  parseXmlSelector,
  selectJson,
  selectXml,
  xmlDecode,
} from "./config-text.js";

const values = (text: string, selector: string) => selectXml(text, parseXmlSelector(selector)).map((s) => s.value);

describe("the codec", () => {
  it.each(["utf8", "utf8-bom", "utf16le-bom", "utf16be-bom"] as const)("round-trips %s", (encoding) => {
    const text = "<r a='é'>\r\n\t✓</r>\n";
    const bytes = encodeText(text, encoding);
    expect(decodeText(bytes)).toEqual({ text, encoding });
  });

  it("refuses bytes that are not UTF-8 and carry no UTF-16 BOM", () => {
    expect(() => decodeText(new Uint8Array([0x61, 0xff, 0x62]))).toThrow(ConfigTextError);
  });
});

describe("XML selectors", () => {
  const doc = [
    `<?xml version="1.0"?>`,
    `<!-- <Innovator><DB-Connection database="commented"/></Innovator> -->`,
    `<Innovator>`,
    `  <operating_parameter key="temp_folder" value="C:\\t\\" />`,
    `  <operating_parameter key="debug_log_prefix" value='C:\\l\\' />`,
    `  <DB-Connection id="a" database="x &amp; y"/>`,
    `  <Group><Url value="u1"/><Inner><Url value="u2"/></Inner></Group>`,
    `  <Note><![CDATA[<not-an-element/>]]></Note>`,
    `  <Name>plain &lt;text&gt;</Name>`,
    `</Innovator>`,
  ].join("\n");

  it("selects attributes by child steps and predicates, decoding entities", () => {
    expect(values(doc, "/Innovator/DB-Connection/@database")).toEqual(["x & y"]);
    expect(values(doc, "/Innovator/operating_parameter[@key='temp_folder']/@value")).toEqual(["C:\\t\\"]);
    expect(values(doc, `/Innovator/operating_parameter[@key="debug_log_prefix"]/@value`)).toEqual(["C:\\l\\"]);
    expect(values(doc, "/Innovator/operating_parameter[@key]/@value")).toHaveLength(2);
    expect(values(doc, "/Innovator/operating_parameter[@nope]/@value")).toEqual([]);
  });

  it("selects descendants with //, any element with *, and text()", () => {
    expect(values(doc, "//Url/@value")).toEqual(["u1", "u2"]);
    expect(values(doc, "/Innovator/Group/Url/@value")).toEqual(["u1"]);
    expect(values(doc, "/Innovator/*/Url/@value")).toEqual(["u1"]);
    expect(values(doc, "/Innovator/Name/text()")).toEqual(["plain <text>"]);
  });

  it("ignores comments, processing instructions and CDATA", () => {
    expect(values(doc, "//DB-Connection/@database")).toEqual(["x & y"]);
    expect(() => values(doc, "/Innovator/Note/text()")).toThrow(/markup/);
  });

  it("refuses text() of an element with children", () => {
    expect(() => values(doc, "/Innovator/Group/text()")).toThrow(/holds elements/);
  });

  it.each(["Innovator/@a", "/Innovator", "/@a", "/Innovator/@a/b", "/Inno vator/@a", "/a[@b=c]/@d"])("refuses the selector %s", (s) => {
    expect(() => parseXmlSelector(s)).toThrow(/bad XML selector/);
  });

  it.each([
    ["an unclosed element", "<r><s></r>"],
    ["a second root", "<r/><s/>"],
    ["no root", "<!-- only -->"],
    ["an unquoted attribute", "<r a=b/>"],
    ["a repeated attribute", `<r a="1" a="2"/>`],
    ["an unterminated comment", "<r><!-- </r>"],
  ])("refuses a document with %s", (_name, text) => {
    expect(() => values(text, "/r/@a")).toThrow(/malformed XML/);
  });

  it("decodes numeric character references", () => {
    expect(xmlDecode("a&#38;b&#x3C;c&unknown;")).toBe("a&b<c&unknown;");
  });
});

describe("JSON pointers", () => {
  const doc = `{\n  /* block */ "a": { "b/c": "x", "list": ["p", "q"] },\n  // line\n  "n": 1, "a2": "\\u0041"\n}`;
  const at = (pointer: string) => selectJson(doc, parseJsonPointer(pointer)).map((s) => s.value);

  it("selects string values by pointer, with escapes", () => {
    expect(at("/a/b~1c")).toEqual(["x"]);
    expect(at("/a/list/1")).toEqual(["q"]);
    expect(at("/a2")).toEqual(["A"]);
    expect(at("/missing")).toEqual([]);
  });

  it("refuses a pointer to a non-string", () => {
    expect(() => at("/n")).toThrow(/not a string/);
    expect(() => at("/a")).toThrow(/object/);
  });

  it("refuses a pointer without a leading slash", () => {
    expect(() => parseJsonPointer("a/b")).toThrow(/bad JSON pointer/);
  });
});
