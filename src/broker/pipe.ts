// The named-pipe transport: the broker listens on `\\.\pipe\arashouse-broker`; a client connects,
// writes one envelope line (`{ v, token, request }`), reads one response line, and the broker ends
// the connection. The request line is bounded in size and in the time it may take to arrive; the
// verb's own time bound is the broker's (broker.ts). On Linux the same code serves a Unix socket,
// which is how the tests run it.

import { createConnection, createServer, type Server, type Socket } from "node:net";
import { redact } from "../core/redact.js";
import type { Secret } from "../core/secret.js";
import { systemClock, type Clock } from "../host/clock.js";
import type { Broker } from "./broker.js";
import {
  CONNECT_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  READ_TIMEOUT_MS,
  encodeLine,
  errorResponse,
  requestIdOf,
  type BrokerResponse,
} from "./protocol.js";
import { tokenMatches } from "./token.js";

class LineTooLong extends Error {}

/**
 * Reads up to the first newline. Rejects with `LineTooLong` past `limit` bytes, and when the
 * stream ends or errors before a newline.
 */
function readLine(socket: Socket, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (err?: Error, line?: string) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      if (err) reject(err);
      else resolve(line as string);
    };
    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const take = newline === -1 ? chunk : chunk.subarray(0, newline);
      size += take.length;
      if (size > limit) return done(new LineTooLong(`the line is larger than ${limit} bytes`));
      chunks.push(take);
      if (newline !== -1) done(undefined, Buffer.concat(chunks).toString("utf8"));
    };
    const onEnd = () => done(new Error("the connection ended before a full line"));
    const onError = (err: Error) => done(err);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PipeServerOptions {
  /** `PIPE_PATH` on Windows; a socket path in the tests. */
  readonly path: string;
  readonly token: Secret;
  readonly broker: Broker;
  readonly clock?: Clock;
  readonly readTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  /** Told of a connection that failed after its request was read (the response could not be written). */
  readonly onError?: (err: unknown) => void;
}

/**
 * Serves `broker` on the pipe. On Windows Node can only widen a pipe's DACL to Everyone, so the pipe
 * is opened read-write to every local user and each request must carry the token (docs/broker.md).
 */
export async function servePipe(options: PipeServerOptions): Promise<Server> {
  const clock = options.clock ?? systemClock;
  const limit = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
  const server = createServer((socket) => void serve(socket));

  const reply = (socket: Socket, response: BrokerResponse) => {
    let line: string;
    try {
      line = encodeLine(response, MAX_RESPONSE_BYTES);
    } catch (err) {
      line = encodeLine(errorResponse(response.id, "Refused", redact((err as Error).message)), MAX_RESPONSE_BYTES);
    }
    socket.end(line);
  };

  const serve = async (socket: Socket) => {
    const started = clock.now();
    socket.on("error", () => socket.destroy());
    socket.setTimeout(options.readTimeoutMs ?? READ_TIMEOUT_MS, () => socket.destroy());
    let line: string;
    try {
      line = await readLine(socket, limit);
    } catch (err) {
      if (err instanceof LineTooLong) {
        await options.broker.rejected("malformed", started);
        reply(socket, errorResponse("", "Refused", `the request is larger than ${limit} bytes`));
      } else {
        socket.destroy();
      }
      return;
    }
    socket.setTimeout(0);
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch {
      await options.broker.rejected("malformed", started);
      return reply(socket, errorResponse("", "Refused", "the request is not JSON"));
    }
    if (!isRecord(envelope) || envelope.v !== PROTOCOL_VERSION || !isRecord(envelope.request)) {
      await options.broker.rejected("malformed", started);
      return reply(socket, errorResponse(requestIdOf(isRecord(envelope) ? envelope.request : undefined), "Refused", `the request is not a protocol ${PROTOCOL_VERSION} envelope`));
    }
    if (!tokenMatches(options.token, envelope.token)) {
      await options.broker.rejected("unauthorised", started);
      return reply(socket, errorResponse(requestIdOf(envelope.request), "Refused", "the request does not carry the broker's token"));
    }
    try {
      reply(socket, await options.broker.handle(envelope.request));
    } catch (err) {
      options.onError?.(err);
      socket.destroy();
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: options.path, readableAll: true, writableAll: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/** The pipe could not be reached, or did not answer in time: nothing is known about the request's effect. */
export class PipeUnreachableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "PipeUnreachableError";
  }
}

export interface CallPipeOptions {
  readonly connectTimeoutMs?: number;
  /** How long to wait for the response once the request is written. */
  readonly responseTimeoutMs: number;
  readonly maxResponseBytes?: number;
}

/** Writes `line` to the pipe and returns the response line. Throws `PipeUnreachableError`. */
export function callPipe(path: string, line: string, options: CallPipeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let settled = false;
    const finish = (err: Error | undefined, response?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(response as string);
    };
    let timer = setTimeout(
      () => finish(new PipeUnreachableError(`could not connect within ${options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS} ms`)),
      options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    socket.on("error", (err: NodeJS.ErrnoException) => finish(new PipeUnreachableError(`the pipe failed: ${err.code ?? err.message}`, { cause: err })));
    socket.on("connect", () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(new PipeUnreachableError(`no response within ${options.responseTimeoutMs} ms`)),
        options.responseTimeoutMs,
      );
      readLine(socket, options.maxResponseBytes ?? MAX_RESPONSE_BYTES).then(
        (response) => finish(undefined, response),
        (err: Error) => finish(new PipeUnreachableError(`no response: ${err.message}`, { cause: err })),
      );
      socket.write(line);
    });
  });
}
