#!/usr/bin/env node
// `arashouse`: the WSL-side CLI. Only `media check` exists so far; the rest of the command surface is built in later tickets.
import { createMsiReader, windowsTempDir } from "../host/msi.js";
import { MEDIA_USAGE, runMediaCheck } from "./media.js";

const io = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };

async function main(argv: readonly string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === "media" && command === "check") {
    // An MSI unpacked from a zip must land where Windows Installer can open it: a Windows drive.
    const scratchDir = await windowsTempDir().catch(() => undefined);
    return runMediaCheck(rest, { readMsi: createMsiReader(), scratchDir }, io);
  }
  io.err(group === undefined ? "arashouse: no command given." : `arashouse: unknown command "${argv.join(" ")}".`);
  io.err(`commands implemented so far:\n  ${MEDIA_USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`arashouse: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
