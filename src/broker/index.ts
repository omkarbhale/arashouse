#!/usr/bin/env node
// `arashouse-broker`: the Windows-side admin service (`ArasHouseBroker`, installed by `arashouse setup`,
// ticket 21). It serves the fixed verbs on `\\.\pipe\arashouse-broker` until it is stopped. See docs/broker.md.

import { redactError } from "../core/redact.js";
import { PIPE_PATH } from "./protocol.js";
import { packageVersion, startBroker } from "./service.js";

const log = (line: string) => process.stderr.write(`arashouse-broker: ${line}\n`);

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    log("runs on Windows only, as the ArasHouseBroker service (arashouse setup)");
    process.exitCode = 2;
    return;
  }
  const running = await startBroker({ onError: (err) => log(redactError(err).message) });
  log(`${packageVersion()} serving ${running.broker.registered().join(", ")} on ${PIPE_PATH}`);
  const stop = () => void running.close().then(() => log("stopped"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err: unknown) => {
  log(`failed to start: ${redactError(err).message}`);
  process.exitCode = 1;
});
