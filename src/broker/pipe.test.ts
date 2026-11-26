import { readFileSync, statSync } from "node:fs";
import { createConnection, type Server } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../core/exit-codes.js";
import { Secret } from "../core/secret.js";
import { MemoryAudit } from "./audit.js";
import { Broker } from "./broker.js";
import { runClient } from "./client.js";
import { HostError } from "../host/errors.js";
import { BrokerHost } from "../host/broker-host.js";
import { pipeTransport } from "../host/broker-transport.js";
import { mappedRoot, type MappedRoot } from "./mapped-fs.fixture.js";
import { testPipePath } from "./pipe-path.fixture.js";
import { PipeUnreachableError, callPipe, servePipe } from "./pipe.js";
import { startBroker, type RunningBroker } from "./service.js";
import { envelopeLine, newToken, readTokenFile, tokenMatches } from "./token.js";
import { registerCoreVerbs } from "./verbs.js";

const ROOT = "C:\\aras_installations";

let root: MappedRoot;
let socket: string;
let token: Secret;
let audit: MemoryAudit;
let server: Server | undefined;
let running: RunningBroker | undefined;

beforeEach(() => {
  root = mappedRoot(ROOT);
  socket = testPipePath(root.dir, "broker.sock");
  token = newToken();
  audit = new MemoryAudit();
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await running?.close();
  server = undefined;
  running = undefined;
  root.cleanup();
});

function makeBroker(): Broker {
  return registerCoreVerbs(new Broker({ root: ROOT, audit }), {
    fs: root.fs,
    brokerVersion: "1.2.3",
    os: () => "Windows_NT 10",
    freeRamBytes: () => 0,
    sqlLogin: async () => null,
  });
}

async function serve(options: { readTimeoutMs?: number; maxRequestBytes?: number } = {}): Promise<void> {
  server = await servePipe({ path: socket, token, broker: makeBroker(), ...options });
}

const send = (line: string) => callPipe(socket, line, { responseTimeoutMs: 2_000 }).then((text) => JSON.parse(text));

/** Writes raw bytes and collects whatever comes back until the broker closes the connection. */
function raw(bytes: string, keepOpen = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = createConnection({ path: socket });
    let out = "";
    c.on("data", (d) => (out += d.toString("utf8")));
    c.on("close", () => resolve(out));
    c.on("error", reject);
    c.write(bytes);
    if (!keepOpen) c.end();
  });
}

describe("the token", () => {
  it("is 64 hex characters, compared in constant time, and redacted", () => {
    expect(token.reveal()).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken().reveal()).not.toBe(token.reveal());
    expect(tokenMatches(token, token.reveal())).toBe(true);
    expect(tokenMatches(token, newToken().reveal())).toBe(false);
    expect(tokenMatches(token, token.reveal().slice(1))).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(String(token)).toBe("[redacted]");
  });
});

describe("the pipe server", () => {
  it("answers one request carrying the token, then ends the connection", async () => {
    await serve();
    expect(await send(envelopeLine(token, { id: "p-1", verb: "ping" }, 65536))).toEqual({
      id: "p-1",
      ok: true,
      result: { ok: true, detail: "arashouse-broker 1.2.3" },
    });
    expect(audit.entries()).toEqual([expect.objectContaining({ id: "p-1", verb: "ping", outcome: "ok" })]);
  });

  it("refuses a request without the right token, and audits it as unauthorised", async () => {
    await serve();
    const wrong = await send(`${JSON.stringify({ v: 1, token: "0".repeat(64), request: { id: "p-2", verb: "ping" } })}\n`);
    expect(wrong).toEqual({ id: "p-2", ok: false, error: { kind: "Refused", message: "the request does not carry the broker's token" } });
    const none = await send(`${JSON.stringify({ v: 1, request: { id: "p-3", verb: "listSlots" } })}\n`);
    expect(none.error.kind).toBe("Refused");
    expect(audit.entries().map((e) => [e.id, e.verb, e.outcome])).toEqual([
      [null, null, "unauthorised"],
      [null, null, "unauthorised"],
    ]);
  });

  it("refuses a line that is not JSON or not an envelope", async () => {
    await serve();
    expect((await send("not json\n")).error.message).toBe("the request is not JSON");
    expect((await send(`${JSON.stringify({ v: 2, token: token.reveal(), request: { id: "p-4" } })}\n`)).error).toEqual({
      kind: "Refused",
      message: "the request is not a protocol 1 envelope",
    });
    expect(audit.entries().map((e) => e.outcome)).toEqual(["malformed", "malformed"]);
  });

  it("refuses a request larger than the limit without reading it all", async () => {
    await serve({ maxRequestBytes: 256 });
    const reply = await raw(`${"x".repeat(10_000)}\n`);
    expect(JSON.parse(reply)).toEqual({ id: "", ok: false, error: { kind: "Refused", message: "the request is larger than 256 bytes" } });
    expect(audit.entries()[0]?.outcome).toBe("malformed");
  });

  it("drops a connection that sends no full line in time", async () => {
    await serve({ readTimeoutMs: 50 });
    expect(await raw('{"v":1', true)).toBe("");
  });

  it("is not reachable once closed: the caller gets PipeUnreachableError", async () => {
    await expect(callPipe(testPipePath(root.dir, "nobody.sock"), "x\n", { responseTimeoutMs: 100 })).rejects.toBeInstanceOf(PipeUnreachableError);
  });
});

describe("the Windows-side client", () => {
  const io = (input: string) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { stdin: Readable.from([input]), stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) },
      out,
      err,
    };
  };

  it("adds the token from its file and prints the broker's answer", async () => {
    running = await startBroker({
      root: ROOT,
      pipePath: socket,
      fs: root.fs,
      tokenPath: join(root.dir, "client.token"),
      audit,
      system: { brokerVersion: "4.5.6", sqlLogin: async () => null },
    });
    const run = io(JSON.stringify({ id: "c-1", verb: "ping" }));
    const code = await runClient([], run.io, { pipePath: socket, tokenFile: join(root.dir, "client.token") });
    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(run.out.join(""))).toEqual({ id: "c-1", ok: true, result: { ok: true, detail: "arashouse-broker 4.5.6" } });
    expect(run.out.join("") + run.err.join("")).not.toContain((await readTokenFile(join(root.dir, "client.token"))).reveal());
  });

  it("exits 6 with an Unreachable answer and a hint when the broker is not there", async () => {
    const run = io(JSON.stringify({ id: "c-2", verb: "ping" }));
    const code = await runClient([], run.io, { pipePath: socket, readToken: async () => token });
    expect(code).toBe(EXIT_CODES.hostUnreachable);
    const answer = JSON.parse(run.out.join(""));
    expect(answer).toMatchObject({ id: "c-2", ok: false, error: { kind: "Unreachable" } });
    expect(answer.error.message).toMatch(/arashouse doctor/);
    expect(run.err.join("")).toMatch(/hint: run `arashouse doctor`/);
  });

  it("exits 6 when the token file cannot be read (the broker never started)", async () => {
    const run = io(JSON.stringify({ id: "c-3", verb: "ping" }));
    expect(await runClient([], run.io, { pipePath: socket, tokenFile: join(root.dir, "missing.token") })).toBe(EXIT_CODES.hostUnreachable);
    expect(run.err.join("")).toMatch(/token file is unreadable \(ENOENT\)/);
  });

  it("exits 2 on a request that is not JSON or a bad timeout", async () => {
    expect(await runClient([], io("{").io, { pipePath: socket, readToken: async () => token })).toBe(EXIT_CODES.usage);
    expect(await runClient(["--timeout-ms", "0"], io("{}").io, { pipePath: socket, readToken: async () => token })).toBe(EXIT_CODES.usage);
  });
});

describe("startBroker", () => {
  it("writes a fresh token readable by its owner only, and refuses a root on the deny-list", async () => {
    const tokenPath = join(root.dir, "client.token");
    running = await startBroker({ root: ROOT, pipePath: socket, fs: root.fs, tokenPath, audit, system: { sqlLogin: async () => null } });
    expect(readFileSync(tokenPath, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    // On Windows a file's mode is not its access: the folder's ACL (ticket 21) keeps the token to its readers.
    if (process.platform !== "win32") expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    await expect(startBroker({ root: "C:\\Program Files\\Aras", pipePath: testPipePath(root.dir, "b.sock"), fs: root.fs, tokenPath })).rejects.toMatchObject({
      kind: "Refused",
    });
  });
});

describe("the native transport: BrokerHost over the pipe, in this process", () => {
  it("adds the token from its file and returns the broker's answer, with no process started", async () => {
    const tokenPath = join(root.dir, "client.token");
    running = await startBroker({ root: ROOT, pipePath: socket, fs: root.fs, tokenPath, audit, system: { brokerVersion: "7.8.9", sqlLogin: async () => null } });
    const host = new BrokerHost(pipeTransport({ pipePath: socket, tokenFile: tokenPath }));
    expect(await host.ping()).toMatchObject({ ok: true, detail: "arashouse-broker 7.8.9" });
  });

  it("is Unreachable when the token file cannot be read (another account, or no broker), and never sends the request", async () => {
    await serve();
    const host = new BrokerHost(pipeTransport({ pipePath: socket, tokenFile: join(root.dir, "missing.token") }));
    const err = await host.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect(err).toMatchObject({ kind: "Unreachable" });
    expect((err as Error).message).toMatch(/token file is unreadable \(ENOENT\).*worker user/);
    expect(audit.lines).toEqual([]);
  });

  it("is Unreachable when nothing listens on the pipe", async () => {
    const host = new BrokerHost(pipeTransport({ pipePath: socket, readToken: async () => token }));
    await expect(host.ping()).rejects.toMatchObject({ kind: "Unreachable" });
  });
});
