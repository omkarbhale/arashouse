import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactError, redactingSink, redactValue } from "./redact.js";
import { SECRET_KINDS, Secret, secretFromEnv, type SecretKind } from "./secret.js";

// Values are assembled at run time so no secret-shaped literal sits in the source.
const VALUES: Record<SecretKind, string> = {
  "sql-sa": ["sa", "pw", "-", "Zq7", "!x"].join(""),
  licence: ["LK", "-", "9F2A", "-", "77C1", "-", "XQ3B"].join(""),
  "lease-password": ["lp", "_", "Rk4t9V", "-", "w1Yd_3m"].join(""),
};

afterEach(() => vi.restoreAllMocks());

describe.each(SECRET_KINDS)("a %s secret", (kind) => {
  const value = VALUES[kind];
  const secret = Secret.of(value, kind);
  const holder = { kind, nested: { secret }, list: [secret] };

  it("reveals its value only through reveal()", () => {
    expect(secret.reveal()).toBe(value);
    expect(secret.kind).toBe(kind);
    expect(secret.length).toBe(value.length);
  });

  it("is [redacted] to String(), a template, concatenation, toString and toJSON", () => {
    expect(String(secret)).toBe("[redacted]");
    expect(`${secret}`).toBe("[redacted]");
    expect("x" + secret).toBe("x[redacted]");
    expect(secret.toString()).toBe("[redacted]");
    expect(secret.toJSON()).toBe("[redacted]");
  });

  it("does not appear in JSON.stringify, spreading, keys or a structured clone", () => {
    expect(JSON.stringify(secret)).toBe('"[redacted]"');
    expect(JSON.stringify(holder)).not.toContain(value);
    expect(JSON.stringify({ ...secret })).not.toContain(value);
    expect(Object.keys(secret)).toEqual(["kind"]);
    expect(JSON.stringify(Object.getOwnPropertyNames(secret))).not.toContain(value);
    expect(JSON.stringify(structuredClone({ ...secret }))).not.toContain(value);
  });

  it("does not appear in util.inspect at any depth, or in the formatted output of console methods", () => {
    expect(inspect(secret)).toBe("[redacted]");
    expect(inspect(holder, { depth: null, showHidden: true })).not.toContain(value);
    expect(inspect(holder, { depth: null })).toContain("[redacted]");
    const out: string[] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void out.push(args.map((a) => inspect(a)).join(" ")));
      console[method](secret, holder, `${secret}`);
    }
    expect(out.join("\n")).not.toContain(value);
  });

  it("does not appear in a captured stdout or stderr", () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => (written.push(String(chunk)), true);
    vi.spyOn(process.stdout, "write").mockImplementation(capture as never);
    vi.spyOn(process.stderr, "write").mockImplementation(capture as never);
    process.stdout.write(`${secret}\n`);
    process.stderr.write(inspect(holder));
    process.stdout.write(JSON.stringify(holder));
    expect(written.join("")).not.toContain(value);
  });

  it("does not appear in an Error built from it, or in that error's stack", () => {
    const err = new Error(`bad credential ${secret}`);
    expect(err.message).not.toContain(value);
    expect(err.stack).not.toContain(value);
    expect(JSON.stringify(redactError(err))).not.toContain(value);
    // Even one built from the revealed value is scrubbed by redactError.
    const leaky = new Error(`bad credential ${secret.reveal()}`);
    expect(leaky.message).toContain(value);
    const safe = redactError(leaky);
    expect(safe.message).not.toContain(value);
    expect(safe.stack).not.toContain(value);
    expect(redactValue(leaky)).not.toContain(value);
  });

  it("does not appear in an events or audit log written through the redacting sink", () => {
    const lines: string[] = [];
    const log = redactingSink((line) => lines.push(line));
    log({ event: "credentials-set", secret, detail: holder });
    log(`plain text that leaked ${secret.reveal()}`);
    log(new Error(`failed with ${secret.reveal()}`));
    log({ url: `https://x/?q=${encodeURIComponent(secret.reveal())}`, body: JSON.stringify({ v: secret.reveal() }) });
    log({ header: `Basic ${Buffer.from(secret.reveal()).toString("base64")}` });
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).not.toContain(value);
    expect(lines.join("\n")).not.toContain(encodeURIComponent(value));
    expect(lines.join("\n")).not.toContain(Buffer.from(value).toString("base64"));
  });
});

describe("Secret", () => {
  it("rejects a non-string and an unknown kind", () => {
    expect(() => Secret.of(1 as never, "licence")).toThrow(TypeError);
    expect(() => Secret.of("abcdef", "token" as never)).toThrow(TypeError);
  });

  it("is frozen and recognised by isSecret", () => {
    const secret = Secret.of("abcdefgh", "licence");
    expect(Object.isFrozen(secret)).toBe(true);
    expect(Secret.isSecret(secret)).toBe(true);
    expect(Secret.isSecret("abcdefgh")).toBe(false);
  });
});

describe("secretFromEnv", () => {
  it("reads a secret from the environment and removes the variable", () => {
    const env: NodeJS.ProcessEnv = { ARASHOUSE_TEST_VALUE: "env-supplied-1", OTHER: "x" };
    const secret = secretFromEnv("ARASHOUSE_TEST_VALUE", "lease-password", { env });
    expect(secret?.reveal()).toBe("env-supplied-1");
    expect(secret?.kind).toBe("lease-password");
    expect(env).toEqual({ OTHER: "x" });
  });

  it("can leave the variable in place", () => {
    const env: NodeJS.ProcessEnv = { ARASHOUSE_TEST_VALUE: "env-supplied-2" };
    secretFromEnv("ARASHOUSE_TEST_VALUE", "sql-sa", { env, consume: false });
    expect(env.ARASHOUSE_TEST_VALUE).toBe("env-supplied-2");
  });

  it("is undefined for an unset or empty variable", () => {
    expect(secretFromEnv("NOPE", "licence", { env: {} })).toBeUndefined();
    expect(secretFromEnv("EMPTY", "licence", { env: { EMPTY: "" } })).toBeUndefined();
  });
});
