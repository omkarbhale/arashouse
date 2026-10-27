#!/usr/bin/env node
// `arashouse`: the WSL-side CLI. The command surface is in commands.ts; see docs/cli.md.
import { runCli } from "./commands.js";

runCli(process.argv.slice(2), { out: (line) => console.log(line), err: (line) => console.error(line) }).then((code) => {
  process.exitCode = code;
});
