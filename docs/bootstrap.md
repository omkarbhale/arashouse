# Bootstrap recipes: `get --bootstrap` and `bootstrap --lease`

Ticket 42. It ties the bootstrap steps together: the database restore (ticket 39, `docs/restore.md`), code deployments
(ticket 40, `docs/code-deploy.md`), package imports (ticket 41, `docs/import.md`) and the git baseline (ticket 53,
`docs/git-baseline.md`). The captain:

> "some kind of automation to get the Aras going. Perhaps a optional database restore, followed by import/codetree
> deployments. This is similar to worktree in that sense."

A recipe is the whole bring-up of a lease in one JSON file, the way a worktree is populated from a branch:

```
arashouse get [<flavor>] --bootstrap <recipe.json | @name> --holder <task> [--wait <seconds>] [--json] [--password-fd <n>] [--keep-on-fail]
arashouse bootstrap --lease <lease_id> <recipe.json | @name> [--yes] [--json]
```

`@name` is `$ARASHOUSE_HOME/recipes/<name>.json` (`%LOCALAPPDATA%\arashouse\recipes\` by default). A name is letters, digits, `.`, `_`
and `-`.

## A worked example

`~/work/r23/recipe.json`, next to the folders it names:

```json
{
  "flavor": "23",
  "restore": "profiles/demo.bak",
  "code": [
    { "from": "./overlay", "to": "Innovator/Client" },
    { "from": "./build/methods.zip", "to": "Innovator/Server/bin" }
  ],
  "import": [
    { "manifest": "./pkgs/imports.mf", "merge": true, "release": "R1" }
  ],
  "git": true,
  "agent": false,
  "atomic": true
}
```

```
$ arashouse get --bootstrap ~/work/r23/recipe.json --holder my-task
leased 23-02 (Release 23 (14.0 SP9), engine 14.0.7) to my-task
url:       http://172.19.0.1/ah-23-02
database:  arashouse_23_02
user:      root
lease id:  6f1c...
password:  not shown; use `arashouse run --lease 6f1c... -- <command>`
recipe:    /home/me/work/r23/recipe.json
restore:   ok in 14.2 s (restored a backup over the database of 23-02 ...)
code:      ok in 21.7 s (2 deploys, 38 files)
import:    ok in 48.0 s (1 import)
git:       ok in 31.5 s (commit 3b9e... of 4211 files, built in 12.9 s; ...)
health:    ok in 0.9 s (Client/, the OAuth server and DBList.aspx answer at http://172.19.0.1/ah-23-02)
return it with: arashouse return 6f1c...
```

The flavor may be given on the command line, in the recipe, or both (then they must agree). With `--json`, stdout is the
lease contract (`docs/schemas/get.schema.json`) with `bootstrap: { recipe, steps, code?, git? }` and, when the recipe
imports, `imports`. Each step is `{ name, status, ok, ms, log, detail }`, in the order below, each once:

```json
{ "name": "import", "status": "ok", "ok": true, "ms": 48012, "log": "/home/me/.arashouse/logs/6f1c...-import-1.log", "detail": "1 import" }
```

## The recipe

`docs/schemas/recipe.schema.json` is its schema. Every key is optional; an empty recipe is a lease with a health check.
Paths are relative to the recipe file (a Windows drive path is taken as it is).

| key | what | as on the command line |
|---|---|---|
| `flavor` | `12sp9`, `23` or `35` | `get <flavor>` |
| `restore` | a `.bak` path or a profile name; or `{ "from", "allow_foreign_origin", "skip_version_check" }` | `--restore` and its overrides |
| `code` | a list of `{ "from", "to", "allow_config", "allow_servers" }`; `to` defaults to `Innovator`, `.` is the top | `--code <from>:<to>`, `--allow-config`, `--allow-servers` (per entry here) |
| `import` | a list of `{ "manifest", "merge", "release", "description", "packages", "os_user", "languages", "collect_errors", "batch", "timeout", "engine", "skip_version_check" }` | `--import <manifest>` and its options; `"merge": false` is `--no-merge` |
| `git` | `true` makes the git baseline | `--git` |
| `agent` | `true` starts the slot's agent service | `--agent` |
| `atomic` | `false` keeps the lease when a step fails | `--keep-on-fail` |

**No secrets.** A recipe never holds one: the lease's password is made at `get`, and imports get it in their environment
only. A key that looks like a secret (`password`, `key`, `api_key`, `token`, `secret`, `credential`, `licence`, ...) is
refused at any depth, and the message names the key, never its value. An unknown key, or a value of the wrong kind, is
refused too (exit 2).

**Checked before the lease.** The recipe is read and every step prepared before a slot is reserved, exactly as the
command-line options are: the backup must exist, each code source is planned against the guards (a refused one exits 7:
`..`, a junction, `InnovatorServerConfig.xml` without `allow_config`, a `.gitignore` where `git` will make its own), each
import is checked against the flavor's engine, and aras-pkg and git must run. So a bad path costs no slot.

With `--bootstrap`, the bring-up options (`--restore`, `--code`, `--import`, `--git`, `--agent`, `--atomic` and their
overrides) go in the recipe; given beside it they are refused (exit 2). `--holder`, `--wait`, `--json`, `--password-fd` and
`--keep-on-fail` stay on the command line.

## The order

Fixed, because each step assumes the ones before it:

1. **lease**: a clean slot, as `get` always takes one.
2. **restore**: the backup replaces the database, so everything after lands in it (inside `get`, before the lease's
   password is set; `docs/restore.md`).
3. **code**: may hold methods an import references, so it goes before the imports (`docs/code-deploy.md`).
4. **import**: the packages, into the restored database, with the deployed code in place (`docs/import.md`).
5. **git**: the baseline commits the tree as handed over, with the code deployed (`docs/git-baseline.md`). It recycles the
   slot's pools.
6. **health**: last, so it sees the slot as it is handed over: from the CLI's process, the slot's `Client/`, its OAuth server's discovery
   document and `DBList.aspx` (exactly the lease's database) must answer at the lease's URL (`probeSlot`,
   `docs/slot-url.md`), with the cold-start timeout.
7. **hand out**.

A step whose section is absent is reported as `skipped` ("not in the recipe"); the health check always runs.

## A failed step

**Atomic, by default.** The first step that fails stops the run, every step after it is reported as `skipped` ("not
reached: the code step failed"), the lease is returned (its slot is reset as usual, so whatever the steps did is
discarded) and `get` exits 9. stderr names the step, its detail and its log, and lists every step. Nothing is printed on
stdout.

**`--keep-on-fail`** (or `"atomic": false`) keeps the lease instead, so a human can look: `get` prints the lease (with
`bootstrap.steps` saying which step failed) and still exits 9.

**A failed restore always returns the lease**, `--keep-on-fail` or not: the restore runs inside `get` before the lease's
password is set, so the lease would have a database nobody can log in to. What stopped `get` after the restore had run
(the lease's password could not be set in the restored database, for example) is the restore step's failure too.

## Logs

In `$ARASHOUSE_HOME/logs/` (mode 700, files 600), as the import logs are. Each step's `log`:

- **import**: the last aras-pkg log it wrote, `<lease_id>-import-<n>.log` (the one that failed, when one did);
- **the others**: `<lease_id>-bootstrap.log`, one line per step (time, status, milliseconds, detail) and, for the code step,
  one line per deploy. Appended to, so a later `arashouse bootstrap` on the lease adds to it.

Every line is redacted; no log holds the lease's password (the tests grep the folder for it).

## `bootstrap --lease`: a recipe on a lease already held

Applies a recipe to a lease you hold, in the same order (restore, code, import, git, health). The lease is never
returned: a failed step exits 9 and the lease is kept. The recipe's `flavor`, when it has one, must be the lease's.

- **restore** replaces the lease's database, which the command says on stderr before it runs. The lease keeps its
  password: the broker carries the `root` and `admin` password hashes the database has now (the lease's) into the restored
  one, as it carries a free slot's at `get`. The lease's agent is started again when it has one. Imports made onto the
  lease (counted on the lease: `status` shows `imports:<n>`) are in the database it replaces, so a recipe with a restore
  needs `--yes` when the lease has any.
- **code** and **import** run as `deploy-code` and `import` do.
- **git** is skipped when the lease already has a baseline (re-applying a recipe then shows its deploys in `git diff`);
  a code entry that writes the repository's place is refused (exit 7), as `deploy-code` refuses it.
- `agent` and `atomic` apply at `get` only.

With `--json`, stdout is `{ slot, lease_id, bootstrap: { recipe, steps, code?, git? }, imports? }`
(`docs/schemas/bootstrap.schema.json`). No password.

## Exit codes

| code | when |
|---|---|
| 0 | every step in the recipe passed, and the health check |
| 2 | the recipe is not JSON, has a key that looks like a secret or that it does not know, names a file that is not there, or a bring-up option was given beside `--bootstrap`; a restore over imports without `--yes` |
| 3 | no slot of the flavor (as `get`) |
| 4 | `bootstrap --lease` names a lease that is not held |
| 7 | a guard refused a code entry (before any slot was reserved) |
| 9 | a step failed: the lease was returned, unless `--keep-on-fail`, `"atomic": false` or `bootstrap --lease` kept it |

## Measured on the host (2026-10-28)

From WSL, non-elevated, against the installed broker (no broker change: the recipe is CLI-only), with
import-export-libs-js `76ace6e4` built on its own. One lease at a time, each returned with `return --wait`; `12sp9-01`
was held by another holder throughout and was never handed out. Each recipe sits in its own folder with what it names,
by relative paths: the backup, a one-file client overlay (`arashouse42-<case>.txt`) and libs-js's `s1-base` fixture for the
flavor's engine (`LIBSJS-SCRATCH-BASE`, 19 item files). Each lease was then probed through `arashouse run --lease`: `root`
logs in with the lease's password, and the `Variable` rows and the package are read.

**A recipe with all three sections and `git`**, `{ flavor, restore, code: [{ from: "./overlay", to: "Innovator/Client" }],
import: [{ manifest: "./s1-base" }], git: true }`, run as `get --bootstrap <recipe> --json` (the flavor from the recipe):

| flavor | backup restored | exit, whole `get` | restore | code | import | git | health | then |
|---|---|---|---|---|---|---|---|---|
| `12sp9` | ticket 39's 12sp9 scratch database (SQL Server 15) | 0, 217 s | 16.1 s | 13.9 s, 1 file | 37.3 s | 118.8 s, 23061 files | ok | overlay served; `root` logs in; `ARASHOUSE39_MARK = restored-scratch`, `VersionBuild = 24090`; the package present |
| `23` | the Release 23 CD's `CoreAndSolutions140.bak` (SQL Server 11) | 0, 294 s | 27.5 s | 19.4 s, 1 file | 27.6 s | 178.6 s, 25205 files | ok | overlay served; `root` logs in; `VersionBuild = 36073` |
| `35` | the Release 35 CD's `CoreAndSolutions140.bak` (SQL Server 13) | 0, 311 s | 24.5 s | 17.9 s, 1 file | 29.4 s | 198.8 s, 22901 files | ok | overlay served; `root` logs in; `VersionBuild = 43890` |

Each lease's record read `restore:custom,code:1 files, manifest <hash>,code_deploys:1,imports:1,git:<commit>`, and each was
returned and reset. The git step is most of the time: the commit of the whole tree is built from WSL through Git for
Windows (`docs/git-baseline.md`).

**`bootstrap --lease` on the 12sp9 lease above**, with `{ "restore": "backup.bak" }`: refused without `--yes` (exit 2: the
lease had one import); with `--yes`, exit 0 (restore 19.8 s, then the health check). After it, `root` still logs in with the
**same lease password** (the broker carried the lease's hashes), `ARASHOUSE39_MARK` is there and `LIBSJS-SCRATCH-BASE` is
**gone** (the database was replaced).

**Failures:**

| case | result |
|---|---|
| a code entry from a folder that is not there | exit 7 in 0.1 s |
| a recipe with a `password` key | exit 2 in 0.1 s |
| (both) | no slot reserved: the leased set and the event log's length unchanged |
| a corrupt backup (ticket 39's, cut to 20 MB), with `--keep-on-fail` | exit 9 in 33 s: `the bootstrap's restore step failed (the staged backup cannot be read: ... VERIFY DATABASE is terminating abnormally ...)`, every later step `skipped (not reached: the restore step failed)`; the lease of `12sp9-02` returned anyway, the slot reset, no staging folder left |
| a 23 recipe whose import names a package folder that is not there | exit 9 in 50 s: `the bootstrap's import step failed (import 1 of 1 (./bad, engine 14.0.7) failed: aras-pkg exit 1; its log: ...)`; the code step had run; git and health not reached; the lease of `23-01` returned and reset |
| the same with `--keep-on-fail` | exit 9 in 73 s; the lease of `23-02` kept and printed with `bootstrap.steps` (`import: failed`), then returned by hand |

**No password**: each lease's password was looked for in all 40 files of `~/.arashouse` (state, events, lease files, every
log) and in everything the commands printed except `get --json`'s stdout: found in none.

The run found three things, all fixed before this record: the report called a step before the failed one "not reached"
when it was not in the recipe; a failed import named its log twice; and the proof's own package check read the "no items"
fault (which echoes the query) as the package being there.
