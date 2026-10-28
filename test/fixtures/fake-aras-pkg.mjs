// Stands in for import-export-libs-js's `aras-pkg` in the CLI tests of `get --import` and `import` (ticket 41). It appends
// one JSON line per run to $FAKE_APKG_RECORD: its arguments, the ARAS_* variables it was given (the password only as its
// SHA-256, so the record itself never holds it) and its working directory. It writes a log line to its `--log`, and exits
// with the number on the manifest's first line (`exit=<n>`), 0 when there is none. `--version` prints 9.9.9-fake.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("9.9.9-fake\n");
  process.exit(0);
}
const env = process.env;
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const manifest = args[1];
const exit = Number(/^exit=(\d+)/.exec(readFileSync(manifest, "utf8"))?.[1] ?? "0");
appendFileSync(
  env.FAKE_APKG_RECORD,
  `${JSON.stringify({
    args,
    env: {
      ARAS_URL: env.ARAS_URL,
      ARAS_DATABASE: env.ARAS_DATABASE,
      ARAS_USER: env.ARAS_USER,
      ARAS_PKG_ENGINE: env.ARAS_PKG_ENGINE,
      ARAS_PASSWORD_SHA256: env.ARAS_PASSWORD === undefined ? null : createHash("sha256").update(env.ARAS_PASSWORD).digest("hex"),
    },
  })}\n`,
);
writeFileSync(flag("--log"), `[INFO] fake import of ${manifest} with engine ${flag("--engine")}\n`);
process.stderr.write(`[INFO] fake import of ${manifest}\n`);
process.stdout.write(exit === 0 ? "Imported.\n" : "Failed.\n");
process.exit(exit);
