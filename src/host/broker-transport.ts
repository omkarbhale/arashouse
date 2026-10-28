// How `BrokerHost` reaches the broker from WSL: it starts the Windows `node.exe` directly through
// interop (not through `cmd.exe` or PowerShell; ticket 09 measured 92 ms, 147 ms and 446 ms) running
// the broker's client script, writes the request on its stdin and reads the response from its stdout.
// The client adds the token on the Windows side, so no secret crosses to WSL.
//
// On a loaded host WSL sometimes cannot set up the interop channels for the new Windows process and
// prints its own error instead (`<3>WSL (<pid> - ) ERROR: UtilAcceptVsock:273: accept4 failed 110`,
// ticket 38): `node.exe` never ran, so the request never left WSL. Such a start is tried again, a
// few times (ticket 56). Nothing else is: a client that ran may have handed the request to the
// broker, and a verb must not run twice.

import { spawn } from "node:child_process";
import { setTimeout as sleepMs } from "node:timers/promises";
import { existsSync } from "node:fs";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, UNREACHABLE_HINT, encodeLine, type BrokerRequest } from "../broker/protocol.js";
import { DEFAULT_INSTALL_ROOT, brokerClientScript } from "../core/names.js";
import { redact } from "../core/redact.js";
import { HostError } from "./errors.js";

/** One round trip to the broker: resolves the response as parsed JSON, or rejects with a `HostError`. */
export interface BrokerTransport {
  call(request: BrokerRequest, timeoutMs: number): Promise<unknown>;
}

/** The Windows `node.exe` as WSL sees it; `ARASHOUSE_WINDOWS_NODE` overrides it. */
export const WINDOWS_NODE_ENV = "ARASHOUSE_WINDOWS_NODE";
export const DEFAULT_WINDOWS_NODE = "/mnt/c/Program Files/nodejs/node.exe";

/** What the client and the process start may add to the verb's own bound before WSL gives up. */
const TRANSPORT_MARGIN_MS = 10_000;
const CLIP = 300;

/** How many times a call starts `node.exe` when WSL fails to start it; the waits between, growing. */
export const INTEROP_START_ATTEMPTS = 3;
export const INTEROP_RETRY_DELAY_MS = 1_000;

/**
 * WSL's own error line when it cannot connect a Windows process's channels (vsock accept, connect or bind). It is
 * written by the WSL side before the process runs; the client's own lines start `arashouse-broker client:`.
 */
const INTEROP_START_FAILURE = /^<\d+>WSL \(\d+[^)]*\) ERROR: Util\w*Vsock\w*:/m;
const CLIENT_LINE = /arashouse-broker client:/;

/**
 * Whether a client run that printed nothing on stdout failed in WSL's interop start, before `node.exe` could read the
 * request: WSL's error line on stderr and no line from the client. Anything else may have reached the broker.
 */
export function isInteropStartFailure(stdout: string, stderr: string): boolean {
  return stdout === "" && INTEROP_START_FAILURE.test(stderr) && !CLIENT_LINE.test(stderr);
}

export interface InteropOptions {
  /** The `node.exe` to start, as a WSL path. */
  readonly node?: string;
  /** The client script, as the Windows path `node.exe` is given. */
  readonly clientScript?: string;
  /** The working folder; a `\\wsl.localhost\` one makes Windows tools warn, so a `C:` folder is used when there is one. */
  readonly cwd?: string;
  /** Starts of `node.exe` per call when WSL fails to start it; default `INTEROP_START_ATTEMPTS`. */
  readonly startAttempts?: number;
  /** How the transport waits between starts; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function unreachable(why: string): HostError {
  return new HostError("Unreachable", `cannot reach the broker: ${redact(why).slice(0, CLIP)}; ${UNREACHABLE_HINT}`);
}

export function interopTransport(options: InteropOptions = {}): BrokerTransport {
  const node = options.node ?? DEFAULT_WINDOWS_NODE;
  const clientScript = options.clientScript ?? brokerClientScript(DEFAULT_INSTALL_ROOT);
  const cwd = options.cwd ?? (existsSync("/mnt/c/") ? "/mnt/c/" : undefined);
  const attempts = options.startAttempts ?? INTEROP_START_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => sleepMs(ms).then(() => undefined));

  type Start = { readonly value: unknown } | { readonly interop: HostError };

  /** One start of the client: its response, or `interop` when WSL could not start it (the request never left WSL). */
  const once = (line: string, timeoutMs: number): Promise<Start> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err: HostError | undefined, start?: Start) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(start as Start);
      };
      const child = spawn(node, [clientScript, "--timeout-ms", String(timeoutMs)], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        settle(unreachable(`no answer within ${timeoutMs + TRANSPORT_MARGIN_MS} ms`));
      }, timeoutMs + TRANSPORT_MARGIN_MS);
      const out: Buffer[] = [];
      let outSize = 0;
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => {
        outSize += chunk.length;
        if (outSize > MAX_RESPONSE_BYTES + 1) {
          child.kill();
          settle(unreachable(`the response is larger than ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (err.length < CLIP) err += chunk.toString("utf8");
      });
      child.on("error", (e: NodeJS.ErrnoException) => settle(unreachable(`cannot start ${node} (${e.code ?? e.message})`)));
      child.on("close", (code) => {
        const all = Buffer.concat(out).toString("utf8");
        if (isInteropStartFailure(all, err)) {
          settle(undefined, { interop: unreachable(`WSL could not start ${node} (exit ${String(code)}): ${err.trim()}`) });
          return;
        }
        const text = all.split("\n", 1)[0] ?? "";
        if (text === "") {
          settle(unreachable(`the client exited ${String(code)} with no response${err.trim() ? `: ${err.trim()}` : ""}`));
          return;
        }
        try {
          settle(undefined, { value: JSON.parse(text) });
        } catch {
          settle(unreachable(`the client exited ${String(code)} with a response that is not JSON`));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(line);
    });

  return {
    async call(request, timeoutMs) {
      let line: string;
      try {
        line = encodeLine(request, MAX_REQUEST_BYTES);
      } catch (err) {
        throw new HostError("Refused", (err as Error).message);
      }
      for (let attempt = 1; ; attempt++) {
        const answer = await once(line, timeoutMs);
        if ("value" in answer) return answer.value;
        if (attempt >= attempts) throw answer.interop;
        await sleep(INTEROP_RETRY_DELAY_MS * attempt);
      }
    },
  };
}
