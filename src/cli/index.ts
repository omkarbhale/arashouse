#!/usr/bin/env node
// `arashouse`: the CLI. The command surface is in commands.ts; see docs/cli.md. In WSL it is the launcher of the
// Windows build (src/launcher/launcher.ts), unless the host is the fake one; only the one that runs is loaded.
import { launcherApplies } from "../launcher/applies.js";

const argv = process.argv.slice(2);
// A reader that stops early (`| head`) closes the pipe: what is left is dropped, as console.log drops it.
const write = (stream: NodeJS.WriteStream) => {
  stream.on("error", () => undefined);
  return (chunk: string) => void stream.write(chunk);
};
const done = launcherApplies(process.env)
  ? import("../launcher/launcher.js").then(({ runLauncher }) => runLauncher(argv, { env: process.env, io: { stdout: write(process.stdout), stderr: write(process.stderr) } }))
  : import("./commands.js").then(({ runCli }) => runCli(argv, { out: (line) => console.log(line), err: (line) => console.error(line) }));
done.then((code) => {
  process.exitCode = code;
});
