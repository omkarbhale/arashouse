// Stands in for the broker's Windows-side client in the interop transport's tests. It reads the
// request from stdin and acts on its id's prefix: `echo-` answers ping with the argv it was given,
// `silent-` exits 6 with only a stderr line, `garbage-` prints a line that is not JSON, `hang-` never exits.
// `interop-` stands in for WSL failing to start `node.exe` (its own error line, exit 1) the first
// `args.fail` times, counted in the `args.count` file, and then answers as `echo-` does; `silent-`
// counts its runs there too.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const runs = (file) => (existsSync(file) ? readFileSync(file, "utf8").length : 0);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const id = String(request.id);
  const count = request.args?.count;
  if (count) appendFileSync(count, "x");
  if (id.startsWith("interop-") && runs(count) <= Number(request.args?.fail ?? Infinity)) {
    process.stderr.write("<3>WSL (2925201 - ) ERROR: UtilAcceptVsock:273: accept4 failed 110\n");
    process.exitCode = 1;
  } else if (id.startsWith("echo-") || id.startsWith("interop-")) {
    process.stdout.write(`${JSON.stringify({ id, ok: true, result: { ok: true, detail: process.argv.slice(2).join(" ") } })}\n`);
  } else if (id.startsWith("silent-")) {
    process.stderr.write("cannot reach the broker\n");
    process.exitCode = 6;
  } else if (id.startsWith("garbage-")) {
    process.stdout.write("nope\n");
  } else if (id.startsWith("hang-")) {
    setInterval(() => {}, 1000);
  }
});
