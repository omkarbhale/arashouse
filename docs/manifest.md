# The golden manifest and `baseline verify`

Golden is immutable, and a reset must be provably back to it, cheaply. Ticket 28.

Code: `src/core/manifest.ts` (pure: hashing, parsing, the comparison) and `src/broker/manifest-fs.ts`
(the Windows side: scan, hash, build, verify). Runtime directories are data in the flavor registry
(`src/core/flavors.ts`, `runtimeDirs`).

## `golden\<key>\manifest.json`

One entry per file of `golden\<key>\tree` outside the runtime directories:

| field | meaning |
|---|---|
| `path` | relative to the tree root, `/` separated, no `..`, no drive letter |
| `size` | bytes |
| `mtime` | last-write time, UTC, 100 ns: `2026-10-22T10:11:12.1234567Z` |
| `sha256` | lower-case hex SHA-256 of the content |

The file head also carries `schema`, `flavor`, `serverBuild` (the build the baseline builder read from
the installed tree, ticket 24), `fileCount`, `totalBytes` and `manifestHash`. `manifestHash` is the
SHA-256 over a version line and the entries sorted by ordinal path order, one
`path NUL size NUL mtime NUL sha256 LF` line each. It is the golden hash that slot stamps and database
markers carry. Two builds of the same tree give the same hash; a changed byte, size or timestamp
changes it. Entries are one per line, so two manifests diff readably.

`writeManifestOnce` links a finished temporary file into place and fails with `exists` if the manifest
is already there: it is written once, by the baseline builder (ticket 24). `readManifest` recomputes
the hash and counts and rejects a hand-edited file as `tampered`.

A tree that holds a link or junction cannot be baselined (`unsupported-entry`). A scan never follows
one: in a verify it is `extra` (not in the manifest) or `changed` with reason `type`.

## Runtime directories

Left out of the manifest, ignored by every verify level, and cleared by the reset (ticket 30):

- `Innovator/Server/temp`, `Innovator/Server/dll`, `Innovator/Server/logs`: everything under them. (The
  installed tree has the server under `Innovator\Server\`; the rules first read `Server/...`, which matched
  nothing in a real tree, and ticket 24 corrected them before the first golden was written.)
- `Innovator/Client/jsBundles`: only `data.json`, which the client rewrites when it first serves (spike 06).
- `OAuthServer/App_Data`: only files directly in it named `*.sqlite*` or `key-*.xml`.

Matching is case-insensitive. The vault lives outside the tree (`<root>\vaults\<key>-<NN>`), so a tree
scan never meets it. Whether `key-*.xml` copies appear anywhere else in a real install is for ticket 24's
first baseline to confirm; the rule is one line in the registry.

## Verification levels

`verifyTree(root, manifest, { level })` returns a `ManifestDiff`; `verifyGolden(goldenDir, flavor, ...)`
reads `manifest.json` and checks `tree` against it.

| level | used by | checks |
|---|---|---|
| `fast` | the reset path (ticket 32), against a slot tree | size and time of every entry; SHA-256 of configs (`*.config`) and `Innovator/Server/bin/*.dll`; no extra file outside the runtime directories |
| `full` | `arashouse baseline verify <flavor> --full`, `doctor --deep` | everything `fast` checks, with every SHA-256 |
| `golden` | before each provision and each baseline-based reset | `fast` on the golden folder against its own manifest; also fails if the manifest hash is not the expected golden hash (`expectedHash`), or if the manifest's `serverBuild` differs from the registry's (when the registry knows it) |

`fast` does not read most file content, so it cannot see a changed byte that keeps size and time in a
file outside the hashed set; `full` does. The reset (ticket 30) restores size and time from golden, and
`full` is the periodic proof.

## The diff

`{ level, ok, checked, hashed, skippedRuntime, counts: { missing, changed, extra }, missing[], changed[],
extra[], truncated, problems[] }`. Counts are complete; each path list holds the first 20 (`limit`). A
changed file carries its reasons: `size`, `mtime`, `content`, `type`, `unreadable`. `problems` holds
whole-baseline failures that are not a path: no tree folder, wrong build, wrong golden hash. A diff
never contains file contents. `summarizeDiff` gives the one-line form.

## Budget

`FAST_VERIFY_BUDGET_MS` is 25 000, the upper end of the stat scan in PowerShell on the host (6 to 25 s,
design 8.3). The offline test checks a 40 000-file generated tree against it. On the WSL development
machine a scan of that tree takes a few seconds. On the host, the broker checked the first real golden (`12sp9`,
23,760 files, 557 MB) at the `golden` level in 1.7 s and at `full` in 23.8 s (6.5 s warm), round trip from WSL (`docs/baselines.md`). The scan uses `lstat` with 64 in flight; hashing uses 8 streams. The measured
full-content rate on the host was about 2 MB/s with real-time scanning (design 8.3), so `full` is a
manual or `doctor --deep` operation, never the reset path.

## Host driver

`HostDriver.baselineVerify(flavor, { level })` returns `{ ok, ms, detail, level, diff? }`; `level`
defaults to `golden`. `FakeHost` accepts the same options and refuses an unknown level. On the host the
broker's `baselineVerify` verb (`src/broker/baseline-verbs.ts`, ticket 24) runs `verifyGolden` on
`golden\<key>`; a flavor with no manifest answers `ok: false`, "not built", with no diff. Its time bound is
30 minutes, for `full`. `arashouse baseline verify <flavor> [--full]` is the command (`docs/baselines.md`).
