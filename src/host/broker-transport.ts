// How `BrokerHost` reaches the broker from WSL: it starts the Windows `node.exe` directly through
// interop (not through `cmd.exe` or PowerShell; ticket 09 measured 92 ms, 147 ms and 446 ms) running
// the broker's client script, writes the request on its stdin and reads the response from its stdout.
// The client adds the token on the Windows side, so no secret crosses to WSL.

import { spawn } from "node:child_process";
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

export interface InteropOptions {
  /** The `node.exe` to start, as a WSL path. */
  readonly node?: string;
  /** The client script, as the Windows path `node.exe` is given. */
  readonly clientScript?: string;
  /** The working folder; a `\\wsl.localhost\` one makes Windows tools warn, so a `C:` folder is used when there is one. */
  readonly cwd?: string;
}

function unreachable(why: string): HostError {
  return new HostError("Unreachable", `cannot reach the broker: ${redact(why).slice(0, CLIP)}; ${UNREACHABLE_HINT}`);
}

export function interopTransport(options: InteropOptions = {}): BrokerTransport {
  const node = options.node ?? DEFAULT_WINDOWS_NODE;
  const clientScript = options.clientScript ?? brokerClientScript(DEFAULT_INSTALL_ROOT);
  const cwd = options.cwd ?? (existsSync("/mnt/c/") ? "/mnt/c/" : undefined);
  return {
    call: (request, timeoutMs) =>
      new Promise((resolve, reject) => {
        let line: string;
        try {
          line = encodeLine(request, MAX_REQUEST_BYTES);
        } catch (err) {
          reject(new HostError("Refused", (err as Error).message));
          return;
        }
        let settled = false;
        const settle = (err: HostError | undefined, value?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(value);
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
          const text = Buffer.concat(out).toString("utf8").split("\n", 1)[0] ?? "";
          if (text === "") {
            settle(unreachable(`the client exited ${String(code)} with no response${err.trim() ? `: ${err.trim()}` : ""}`));
            return;
          }
          try {
            settle(undefined, JSON.parse(text));
          } catch {
            settle(unreachable(`the client exited ${String(code)} with a response that is not JSON`));
          }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(line);
      }),
  };
}
