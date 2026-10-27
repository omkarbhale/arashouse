#!/usr/bin/env node
// The broker's Windows-side client. WSL runs it through interop (`node.exe <root>\broker\app\broker\client.js`,
// no `cmd.exe` and no PowerShell: ticket 09 measured about 0.1 s against 0.15 s and 0.45 s): it reads one
// request from stdin, adds the token from `<root>\broker\client.token`, sends it down the pipe and
// prints the response line on stdout (a Windows process cannot write to `\\wsl.localhost\` paths).
//
// Exit codes: 0 the broker answered (the answer may be an error); 6 the broker could not be reached
// (the printed response is `Unreachable`, with a hint on stderr); 2 the request on stdin was unusable.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../core/exit-codes.js";
import { DEFAULT_INSTALL_ROOT, brokerTokenFile } from "../core/names.js";
import { redact } from "../core/redact.js";
import type { Secret } from "../core/secret.js";
import { PipeUnreachableError, callPipe } from "./pipe.js";
import {
  DEFAULT_VERB_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PIPE_PATH,
  UNREACHABLE_HINT,
  encodeLine,
  errorResponse,
  requestIdOf,
} from "./protocol.js";
import { envelopeLine, readTokenFile } from "./token.js";

/** The margin the client adds to the verb's bound, so the broker's own timeout answers first. */
const RESPONSE_MARGIN_MS = 5_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

export interface ClientIo {
  readonly stdin: AsyncIterable<Buffer | string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface ClientOptions {
  readonly pipePath?: string;
  readonly tokenFile?: string;
  readonly readToken?: (file: string) => Promise<Secret>;
}

async function readStdin(stdin: AsyncIterable<Buffer | string>, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buffer.length;
    if (size > limit) throw new Error(`the request is larger than ${limit} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function timeoutArg(args: readonly string[]): number {
  if (args.length === 0) return DEFAULT_VERB_TIMEOUT_MS;
  const ms = args[0] === "--timeout-ms" && args.length === 2 ? Number(args[1]) : Number.NaN;
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) throw new Error("usage: client.js [--timeout-ms <1..3600000>] < request.json");
  return ms;
}

/** Runs the client once and returns its exit code. */
export async function runClient(args: readonly string[], io: ClientIo, options: ClientOptions = {}): Promise<number> {
  let request: unknown;
  let timeoutMs: number;
  try {
    timeoutMs = timeoutArg(args);
    request = JSON.parse(await readStdin(io.stdin, MAX_REQUEST_BYTES));
  } catch (err) {
    io.stderr(`arashouse-broker client: ${redact((err as Error).message)}\n`);
    return EXIT_CODES.usage;
  }
  const id = requestIdOf(request);
  const pipePath = options.pipePath ?? PIPE_PATH;
  const unreachable = (why: string): number => {
    const message = `cannot reach the broker at ${pipePath}: ${redact(why)}`;
    io.stdout(encodeLine(errorResponse(id, "Unreachable", `${message}; ${UNREACHABLE_HINT}`), MAX_RESPONSE_BYTES));
    io.stderr(`arashouse-broker client: ${message}\nhint: ${UNREACHABLE_HINT}\n`);
    return EXIT_CODES.hostUnreachable;
  };
  let token: Secret;
  try {
    token = await (options.readToken ?? readTokenFile)(options.tokenFile ?? brokerTokenFile(DEFAULT_INSTALL_ROOT));
  } catch (err) {
    return unreachable(`its token file is unreadable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); is the broker running?`);
  }
  let line: string;
  try {
    line = envelopeLine(token, request, MAX_REQUEST_BYTES);
  } catch (err) {
    io.stderr(`arashouse-broker client: ${redact((err as Error).message)}\n`);
    return EXIT_CODES.usage;
  }
  try {
    const response = await callPipe(pipePath, line, { responseTimeoutMs: timeoutMs + RESPONSE_MARGIN_MS });
    io.stdout(`${response}\n`);
    return EXIT_CODES.ok;
  } catch (err) {
    if (err instanceof PipeUnreachableError) return unreachable(err.message);
    throw err;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  runClient(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`arashouse-broker client: ${redact(err instanceof Error ? err.message : String(err))}\n`);
      process.exitCode = 1;
    },
  );
}
