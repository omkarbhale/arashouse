// Stands in for the broker's Windows-side client in the interop transport's tests. It reads the
// request from stdin and acts on its id's prefix: `echo-` answers ping with the argv it was given,
// `silent-` exits 6 with only a stderr line, `garbage-` prints a line that is not JSON, `hang-` never exits.

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const id = String(request.id);
  if (id.startsWith("echo-")) {
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
