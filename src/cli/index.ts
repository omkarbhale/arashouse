#!/usr/bin/env node
// `arashouse`: the CLI. The command surface is in commands.ts; see docs/cli.md. In WSL it is the launcher of the
// Windows build (src/launcher/launcher.ts), unless the host is the fake one.
import { runCli } from "./commands.js";
import { launcherApplies, runLauncher } from "../launcher/launcher.js";

const argv = process.argv.slice(2);
const done = launcherApplies(process.env)
  ? runLauncher(argv, { env: process.env, io: { stdout: (chunk) => void process.stdout.write(chunk), stderr: (chunk) => void process.stderr.write(chunk) } })
  : runCli(argv, { out: (line) => console.log(line), err: (line) => console.error(line) });
done.then((code) => {
  process.exitCode = code;
});
