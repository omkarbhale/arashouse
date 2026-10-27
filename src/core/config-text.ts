// Locating values in a config file's text without re-serialising it, so an edit changes the value's
// own characters and nothing else: encoding, byte order mark, line endings, whitespace, attribute
// order, quoting and comments all survive. Three pieces, each pure:
//
// - the codec: bytes to text and back, keeping UTF-8 (with or without a BOM) or UTF-16 (with one);
// - an XML scanner and an XPath-style selector (`/Innovator/DB-Connection/@database`,
//   `/configuration/appSettings/add[@key='LocalPath']/@value`, `//redirectUri/@value`, `.../text()`);
// - a JSON Pointer locator (`/Logging/LogLevel/Default`) for string values.
//
// Each locator returns spans (`start`/`end` into the text) with the value as the file means it
// (entities decoded, JSON unescaped), and an encoder for writing a new value into that span.

export type ConfigErrorCode = "encoding" | "malformed" | "selector";

export class ConfigTextError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfigTextError";
  }
}

// ---- the codec --------------------------------------------------------------------------------

export type TextEncoding = "utf8" | "utf8-bom" | "utf16le-bom" | "utf16be-bom";

export interface DecodedText {
  readonly text: string;
  readonly encoding: TextEncoding;
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

function swap16(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1] ?? 0;
    out[i + 1] = bytes[i] ?? 0;
  }
  return out;
}

/**
 * The file's text and how it was encoded. Without a BOM the file must be valid UTF-8; a file that
 * would not round-trip to the same bytes is refused rather than rewritten.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  let decoded: DecodedText;
  try {
    if (startsWith(bytes, BOM_UTF8)) {
      decoded = { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)), encoding: "utf8-bom" };
    } else if (startsWith(bytes, [0xff, 0xfe])) {
      decoded = { text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2)), encoding: "utf16le-bom" };
    } else if (startsWith(bytes, [0xfe, 0xff])) {
      decoded = { text: new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2)), encoding: "utf16be-bom" };
    } else {
      decoded = { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), encoding: "utf8" };
    }
  } catch {
    throw new ConfigTextError("encoding", "the file is not valid UTF-8 and has no UTF-16 byte order mark");
  }
  if (!Buffer.from(encodeText(decoded.text, decoded.encoding)).equals(Buffer.from(bytes))) {
    throw new ConfigTextError("encoding", "the file's bytes do not survive a decode and encode unchanged");
  }
  return decoded;
}

export function encodeText(text: string, encoding: TextEncoding): Uint8Array {
  switch (encoding) {
    case "utf8":
      return new Uint8Array(Buffer.from(text, "utf8"));
    case "utf8-bom":
      return new Uint8Array(Buffer.concat([Buffer.from(BOM_UTF8), Buffer.from(text, "utf8")]));
    case "utf16le-bom":
      return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    case "utf16be-bom":
      return new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), swap16(Buffer.from(text, "utf16le"))]));
  }
}

/** A located value: `text.slice(start, end)` is its raw form in the file, `value` what it means. */
export interface ValueSpan {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  /** The raw form of `value` for this span (escaped for its quotes or context). */
  encode(value: string): string;
}

// ---- XML --------------------------------------------------------------------------------------

interface XmlAttribute {
  readonly name: string;
  /** The value's span, inside the quotes. */
  readonly start: number;
  readonly end: number;
  readonly quote: '"' | "'";
}

interface XmlElement {
  readonly name: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: XmlElement[];
  /** The content's span, between the start tag's `>` and the end tag's `<`; empty for `<x/>`. */
  contentStart: number;
  contentEnd: number;
}

const NAME = /[A-Za-z_:][\w.:-]*/y;
const SPACE = /\s*/y;

function at(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function malformed(text: string, pos: number, what: string): ConfigTextError {
  return new ConfigTextError("malformed", `malformed XML at line ${lineOf(text, pos)}: ${what}`);
}

/** The document's elements with source spans; a virtual root holds the top-level element. */
function scanXml(text: string): XmlElement {
  const root: XmlElement = { name: "", attributes: [], children: [], contentStart: 0, contentEnd: text.length };
  const stack: XmlElement[] = [root];
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) break;
    const skip = (open: string, close: string): boolean => {
      if (!text.startsWith(open, lt)) return false;
      const end = text.indexOf(close, lt + open.length);
      if (end < 0) throw malformed(text, lt, `unterminated ${open}`);
      pos = end + close.length;
      return true;
    };
    if (skip("<!--", "-->") || skip("<![CDATA[", "]]>") || skip("<?", "?>") || skip("<!", ">")) continue;
    if (text.startsWith("</", lt)) {
      const name = at(NAME, text, lt + 2);
      const top = stack[stack.length - 1];
      if (!name || !top || top === root || top.name !== name[0]) throw malformed(text, lt, "an end tag that does not match");
      const close = at(SPACE, text, lt + 2 + name[0].length);
      const gt = lt + 2 + name[0].length + (close?.[0].length ?? 0);
      if (text[gt] !== ">") throw malformed(text, lt, "an unterminated end tag");
      top.contentEnd = lt;
      stack.pop();
      pos = gt + 1;
      continue;
    }
    const name = at(NAME, text, lt + 1);
    if (!name) throw malformed(text, lt, "a '<' that starts no tag");
    let p = lt + 1 + name[0].length;
    const attributes: XmlAttribute[] = [];
    for (;;) {
      p += at(SPACE, text, p)?.[0].length ?? 0;
      if (text.startsWith("/>", p) || text[p] === ">") break;
      const attr = at(NAME, text, p);
      if (!attr || p === lt + 1 + name[0].length) throw malformed(text, p, "an attribute that is not name=\"value\"");
      p += attr[0].length;
      p += at(SPACE, text, p)?.[0].length ?? 0;
      if (text[p] !== "=") throw malformed(text, p, `attribute ${attr[0]} has no value`);
      p += 1;
      p += at(SPACE, text, p)?.[0].length ?? 0;
      const quote = text[p];
      if (quote !== '"' && quote !== "'") throw malformed(text, p, `attribute ${attr[0]} is not quoted`);
      const end = text.indexOf(quote, p + 1);
      if (end < 0) throw malformed(text, p, `attribute ${attr[0]} is not closed`);
      if (attributes.some((a) => a.name === attr[0])) throw malformed(text, p, `attribute ${attr[0]} appears twice`);
      attributes.push({ name: attr[0], start: p + 1, end, quote });
      p = end + 1;
      // An attribute must be followed by space, '/>' or '>'.
      if (!/[\s/>]/.test(text[p] ?? "")) throw malformed(text, p, "attributes are not separated");
    }
    const selfClosing = text.startsWith("/>", p);
    const tagEnd = p + (selfClosing ? 2 : 1);
    const parent = stack[stack.length - 1];
    if (!parent) throw malformed(text, lt, "an element outside the document");
    if (parent === root && root.children.length > 0) throw malformed(text, lt, "a second top-level element");
    const element: XmlElement = { name: name[0], attributes, children: [], contentStart: tagEnd, contentEnd: tagEnd };
    parent.children.push(element);
    if (!selfClosing) stack.push(element);
    pos = tagEnd;
  }
  if (stack.length > 1) throw malformed(text, text.length, `element ${stack[stack.length - 1]?.name ?? ""} is not closed`);
  if (root.children.length === 0) throw malformed(text, 0, "no top-level element");
  return root;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML character data as it reads: the five named entities and character references decoded. */
export function xmlDecode(raw: string): string {
  return raw.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    return ENTITIES[ref] ?? whole;
  });
}

function xmlEscape(value: string, quote: '"' | "'" | undefined): string {
  let out = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (quote === '"') out = out.replace(/"/g, "&quot;");
  else if (quote === "'") out = out.replace(/'/g, "&apos;");
  else out = out.replace(/>/g, "&gt;");
  return out.replace(/\r/g, "&#xD;").replace(/\n/g, "&#xA;").replace(/\t/g, "&#x9;");
}

interface Predicate {
  readonly attribute: string;
  /** Absent: the attribute need only be there (`[@name]`). */
  readonly value?: string;
}

interface Step {
  /** `//` before the step: any descendant, not only a child. */
  readonly deep: boolean;
  /** An element name, or `*`. */
  readonly name: string;
  readonly predicates: readonly Predicate[];
}

export interface XmlSelector {
  readonly steps: readonly Step[];
  /** The selected part of each matched element. */
  readonly target: { readonly kind: "attribute"; readonly name: string } | { readonly kind: "text" };
}

const SELECTOR_STEP = /(\/\/?)([A-Za-z_:][\w.:-]*|\*)((?:\[@[A-Za-z_:][\w.:-]*(?:=(?:'[^']*'|"[^"]*"))?\])*)/y;
const SELECTOR_TARGET = /\/(?:@([A-Za-z_:][\w.:-]*)|(text\(\)))$/y;
const PREDICATE = /\[@([A-Za-z_:][\w.:-]*)(?:=(?:'([^']*)'|"([^"]*)"))?\]/g;

/**
 * Parse an XPath-style selector: absolute steps (`/` a child, `//` any descendant), each an element
 * name or `*` with optional `[@name='value']` or `[@name]` predicates, ending in `/@attribute` or
 * `/text()`.
 */
export function parseXmlSelector(selector: string): XmlSelector {
  const bad = (why: string) => new ConfigTextError("selector", `bad XML selector ${JSON.stringify(selector)}: ${why}`);
  if (typeof selector !== "string" || !selector.startsWith("/")) throw bad("it must start with '/'");
  const steps: Step[] = [];
  let pos = 0;
  for (;;) {
    const target = at(SELECTOR_TARGET, selector, pos);
    if (target) {
      if (steps.length === 0) throw bad("it names no element");
      const attribute = target[1];
      return { steps, target: attribute !== undefined ? { kind: "attribute", name: attribute } : { kind: "text" } };
    }
    const step = at(SELECTOR_STEP, selector, pos);
    if (!step || step[0].length === 0) throw bad(`unexpected text at ${JSON.stringify(selector.slice(pos))}`);
    const predicates = [...(step[3] ?? "").matchAll(PREDICATE)].map((m): Predicate => {
      const value = m[2] ?? m[3];
      return value === undefined ? { attribute: m[1] ?? "" } : { attribute: m[1] ?? "", value };
    });
    steps.push({ deep: step[1] === "//", name: step[2] ?? "", predicates });
    pos += step[0].length;
    if (pos >= selector.length) throw bad("it must end in /@attribute or /text()");
  }
}

function attributeValue(text: string, element: XmlElement, name: string): string | undefined {
  const attr = element.attributes.find((a) => a.name === name);
  return attr ? xmlDecode(text.slice(attr.start, attr.end)) : undefined;
}

function descendants(element: XmlElement): XmlElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

/** Every span `selector` selects in `text`, in document order. Text targets must hold no child elements. */
export function selectXml(text: string, selector: XmlSelector): ValueSpan[] {
  let current: XmlElement[] = [scanXml(text)];
  for (const step of selector.steps) {
    const next = new Set<XmlElement>();
    for (const element of current) {
      for (const candidate of step.deep ? descendants(element) : element.children) {
        if (step.name !== "*" && candidate.name !== step.name) continue;
        const holds = (p: Predicate) => {
          const value = attributeValue(text, candidate, p.attribute);
          return p.value === undefined ? value !== undefined : value === p.value;
        };
        if (step.predicates.every(holds)) next.add(candidate);
      }
    }
    current = [...next];
  }
  const spans: ValueSpan[] = [];
  for (const element of current) {
    const target = selector.target;
    if (target.kind === "attribute") {
      const attr = element.attributes.find((a) => a.name === target.name);
      if (!attr) continue;
      spans.push({
        start: attr.start,
        end: attr.end,
        value: xmlDecode(text.slice(attr.start, attr.end)),
        encode: (value) => xmlEscape(value, attr.quote),
      });
    } else {
      if (element.children.length > 0) {
        throw new ConfigTextError("selector", `text() of <${element.name}>, which holds elements, is not a value`);
      }
      const raw = text.slice(element.contentStart, element.contentEnd);
      if (raw.includes("<")) throw new ConfigTextError("selector", `text() of <${element.name}> holds markup`);
      spans.push({
        start: element.contentStart,
        end: element.contentEnd,
        value: xmlDecode(raw),
        encode: (value) => xmlEscape(value, undefined),
      });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// ---- JSON -------------------------------------------------------------------------------------

/** Parse a JSON Pointer (RFC 6901): `/a/b/0`, with `~1` for '/' and `~0` for '~'. */
export function parseJsonPointer(pointer: string): string[] {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new ConfigTextError("selector", `bad JSON pointer ${JSON.stringify(pointer)}: it must start with '/'`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * The string values at `pointer` in `text` (more than one only when an object repeats a key).
 * Comments (`//` and `/* *\/`, which .NET's `appsettings.json` allows) are skipped.
 */
export function selectJson(text: string, pointer: readonly string[]): ValueSpan[] {
  let pos = 0;
  const spans: ValueSpan[] = [];
  const fail = (what: string) => new ConfigTextError("malformed", `malformed JSON at line ${lineOf(text, pos)}: ${what}`);

  const skipSpace = () => {
    for (;;) {
      const m = at(/\s*/y, text, pos);
      pos += m?.[0].length ?? 0;
      if (text.startsWith("//", pos)) {
        const nl = text.indexOf("\n", pos);
        pos = nl < 0 ? text.length : nl + 1;
      } else if (text.startsWith("/*", pos)) {
        const end = text.indexOf("*/", pos + 2);
        if (end < 0) throw fail("an unterminated comment");
        pos = end + 2;
      } else return;
    }
  };

  const readString = (): { start: number; end: number; value: string } => {
    const m = at(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"/y, text, pos);
    if (!m) throw fail("a string expected");
    const start = pos;
    pos += m[0].length;
    return { start, end: pos, value: JSON.parse(m[0]) as string };
  };

  // `depth` is how many pointer tokens the path to this value has matched; -1 once it left the pointer.
  const readValue = (depth: number): void => {
    skipSpace();
    const c = text[pos];
    const onPath = depth >= 0;
    const here = onPath && depth === pointer.length;
    if (c === "{") {
      if (here) throw new ConfigTextError("selector", "the pointer selects an object, not a string");
      pos++;
      skipSpace();
      if (text[pos] === "}") return void pos++;
      for (;;) {
        skipSpace();
        const key = readString();
        skipSpace();
        if (text[pos] !== ":") throw fail("':' expected");
        pos++;
        readValue(onPath && pointer[depth] === key.value ? depth + 1 : -1);
        skipSpace();
        if (text[pos] === ",") pos++;
        else if (text[pos] === "}") return void pos++;
        else throw fail("',' or '}' expected");
      }
    }
    if (c === "[") {
      if (here) throw new ConfigTextError("selector", "the pointer selects an array, not a string");
      pos++;
      skipSpace();
      if (text[pos] === "]") return void pos++;
      for (let index = 0; ; index++) {
        readValue(onPath && pointer[depth] === String(index) ? depth + 1 : -1);
        skipSpace();
        if (text[pos] === ",") pos++;
        else if (text[pos] === "]") return void pos++;
        else throw fail("',' or ']' expected");
      }
    }
    if (c === '"') {
      const s = readString();
      if (here) spans.push({ start: s.start, end: s.end, value: s.value, encode: (value) => JSON.stringify(value) });
      return;
    }
    const scalar = at(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y, text, pos);
    if (!scalar) throw fail("a value expected");
    if (here) throw new ConfigTextError("selector", "the pointer selects a number, boolean or null, not a string");
    pos += scalar[0].length;
  };

  readValue(0);
  skipSpace();
  if (pos !== text.length) throw fail("text after the document");
  return spans;
}
