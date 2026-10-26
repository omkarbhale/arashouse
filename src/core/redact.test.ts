import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactError, redactValue, registerSecretValue } from "./redact.js";

// Samples are assembled from parts so this file never holds a secret-shaped literal.
const j = (...parts: string[]) => parts.join("");

describe("redact: the listed shapes", () => {
  it.each([
    [j("lic", "_key", '="', "ABCD-1234-EFGH", '"'), j("lic", "_key", '="', REDACTED, '"')],
    [j("act", "_key", "=", "ABCD1234"), j("act", "_key", "=", REDACTED)],
    [j("LIC", "_KEY", " = ", "'", "abc def", "'"), j("LIC", "_KEY", " = ", "'", REDACTED, "'")],
    [j("pass", "word", "=", "hunter2"), j("pass", "word", "=", REDACTED)],
    [j("Pass", "word", ": ", "hunter2"), j("Pass", "word", ": ", REDACTED)],
    [j("SA_PASS", "WORD", "=", "hunter2 next"), j("SA_PASS", "WORD", "=", REDACTED, " next")],
    [j("Server=.;User Id=sa;P", "wd", "=", "hunter2;Database=x"), j("Server=.;User Id=sa;P", "wd", "=", REDACTED, ";Database=x")],
    [j("https://h/x?pass", "word", "=", "hunter2&a=1"), j("https://h/x?pass", "word", "=", REDACTED, "&a=1")],
    [j('{"pass', 'word":"', "hunter2", '","user":"root"}'), j('{"pass', 'word":"', REDACTED, '","user":"root"}')],
    [j("LICENSE", "KEY=", "ABC-123"), j("LICENSE", "KEY=", REDACTED)],
    [j("Authorization", ": ", "Basic cm9vdDpodW50ZXIy"), j("Authorization", ": ", REDACTED)],
    [j("authorization", ": ", "Bearer abc.def.ghi\nnext line"), j("authorization", ": ", REDACTED, "\nnext line")],
    [j('"Authorization": "', "Bearer abc.def.ghi", '", "x": 1'), j('"Authorization": "', REDACTED, '", "x": 1')],
    [j("sqlcmd -S . -U sa -", "P", " hunter2 -Q x"), j("sqlcmd -S . -U sa -", "P", " ", REDACTED, " -Q x")],
    [j("sqlcmd -U sa -", "P", ' "hunter 2"'), j("sqlcmd -U sa -", "P", " ", REDACTED)],
    [j("tool --pass", "word", " hunter2 --x"), j("tool --pass", "word", " ", REDACTED, " --x")],
    [j("tool --pass", "word", "=", "hunter2"), j("tool --pass", "word", "=", REDACTED)],
    [j("api tok", "en", ": ", "abc123"), j("api tok", "en", ": ", REDACTED)],
  ])("%s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("redacts every occurrence in multi-line text", () => {
    const text = [j("a pass", "word", "=", "one"), "fine", j("b pass", "word", "=", "two")].join("\n");
    expect(redact(text)).toBe([j("a pass", "word", "=", REDACTED), "fine", j("b pass", "word", "=", REDACTED)].join("\n"));
  });

  it("leaves ordinary text, an empty assignment and the placeholder alone", () => {
    for (const text of [
      "the SQL sa password is typed at a hidden prompt",
      "arashouse get 12sp9 --json",
      "database arashouse_12sp9_01 restored in 41s",
      j("pass", "word", "="),
      j("lic", "_key", "=", " "),
      "sqlcmd -S . -E -Q select 1",
      REDACTED,
      "",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("is idempotent", () => {
    const once = redact(j("pass", "word", "=", "hunter2 ", "Authorization", ": Basic abcdefghij"));
    expect(redact(once)).toBe(once);
  });
});

describe("redact: known secret values", () => {
  const value = j("kn", "own", "-", "Va1ue", "/", "x+y&z");

  it("replaces a registered value, in the forms it travels in, wherever it appears", () => {
    registerSecretValue(value);
    for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64")]) {
      expect(redact(`before ${form} after`)).toBe(`before ${REDACTED} after`);
    }
  });

  it("replaces the longer of two overlapping values whole", () => {
    registerSecretValue(j("over", "lap-one"));
    registerSecretValue(j("over", "lap-one", "-and-more"));
    expect(redact(j("x ", "over", "lap-one", "-and-more", " y"))).toBe(`x ${REDACTED} y`);
  });

  it("ignores a value too short to tell apart from ordinary text", () => {
    registerSecretValue("ab");
    expect(redact("a cab about")).toBe("a cab about");
  });
});

describe("redactValue and redactError", () => {
  it("serialises non-strings as JSON and survives a cycle", () => {
    expect(redactValue({ a: 1, b: [true] })).toBe('{"a":1,"b":[true]}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).not.toThrow();
    expect(redactValue(undefined)).toBe("undefined");
  });

  it("keeps an error's name and removes secrets from its message and stack", () => {
    const err = new TypeError(j("connect failed, pass", "word", "=", "hunter2"));
    const safe = redactError(err);
    expect(safe.name).toBe("TypeError");
    expect(safe.message).toBe(j("connect failed, pass", "word", "=", REDACTED));
    expect(safe.stack).not.toContain("hunter2");
  });

  it("accepts a thrown non-error", () => {
    expect(redactError(j("pass", "word", "=", "hunter2"))).toEqual({ name: "Error", message: j("pass", "word", "=", REDACTED) });
  });
});
