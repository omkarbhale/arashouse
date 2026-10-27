// Starting the broker: vet the root, write a fresh client token, register the verbs, open the audit
// log and serve the pipe. index.ts calls this with the Windows defaults; the tests call it with a
// mapped filesystem and a Unix socket.

import { readFileSync } from "node:fs";
import { freemem, release, type } from "node:os";
import type { Server } from "node:net";
import { assertValidRoot } from "../core/guards.js";
import { DEFAULT_INSTALL_ROOT, brokerTokenFile } from "../core/names.js";
import type { Clock } from "../host/clock.js";
import { guarded } from "../host/owned.js";
import { FileAudit, type AuditSink } from "./audit.js";
import { Broker } from "./broker.js";
import { nodeBrokerFs, type BrokerFs } from "./fs.js";
import { servePipe } from "./pipe.js";
import { PIPE_PATH } from "./protocol.js";
import { powershellSqlProbe } from "./sql-probe.js";
import { newToken, writeTokenFile } from "./token.js";
import { registerCoreVerbs, type BrokerSystem } from "./verbs.js";

/** The version in the installed `package.json` next to `dist\`, or `unknown`. */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export interface StartOptions {
  readonly root?: string;
  readonly pipePath?: string;
  readonly fs?: BrokerFs;
  /** Where the token is written, as a local path; defaults to `brokerTokenFile(root)`. */
  readonly tokenPath?: string;
  readonly audit?: AuditSink;
  readonly clock?: Clock;
  readonly system?: Partial<Omit<BrokerSystem, "fs">>;
  readonly onError?: (err: unknown) => void;
}

export interface RunningBroker {
  readonly broker: Broker;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startBroker(options: StartOptions = {}): Promise<RunningBroker> {
  const fs = options.fs ?? nodeBrokerFs();
  const root = guarded(() => assertValidRoot(options.root ?? DEFAULT_INSTALL_ROOT, { realPath: fs.realPath }));
  const system: BrokerSystem = {
    fs,
    brokerVersion: options.system?.brokerVersion ?? packageVersion(),
    os: options.system?.os ?? (() => `${type()} ${release()}`),
    freeRamBytes: options.system?.freeRamBytes ?? freemem,
    sqlReachable: options.system?.sqlReachable ?? powershellSqlProbe(),
  };
  const broker = registerCoreVerbs(
    new Broker({
      root,
      isReparsePoint: fs.isReparsePoint,
      realPath: fs.realPath,
      audit: options.audit ?? new FileAudit(root),
      clock: options.clock,
      onAuditError: options.onError,
    }),
    system,
  );
  const token = newToken();
  await writeTokenFile(options.tokenPath ?? brokerTokenFile(root), token);
  const server = await servePipe({ path: options.pipePath ?? PIPE_PATH, token, broker, clock: options.clock, onError: options.onError });
  return {
    broker,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
