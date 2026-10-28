# Using a lease: the worker guide

For a worker (a crewmate, a script, a person) told to "use an Aras". You take a **lease** on a clean, disposable Aras
Innovator instance of one version, work on it, take out what you want to keep, and give it back. The operator's side
(setup, baselines, repairs) is `docs/runbook.md`; every option of every command is in `docs/cli.md`.

## The rule

The captain's words:

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever took the lease
> before giving it back."

> "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it has cleaned up."

So:

- **A leased slot is clean.** arashouse hands out only a slot reset to the flavor's out-of-the-box state: its code tree,
  its database and its vault as the golden has them, with a password made for your lease.
- **A returned slot is gone.** `return` discards everything on it: data, imports, code changes, files, the password.
  Do not rely on anything you left there, and do not look for it later.
- **You take out what you need, before you return.** Exports, code, a database backup, logs, notes. arashouse keeps
  none of it, and cannot be asked to preserve a lease.

`return` says it again on stderr every time:

```
Returning slot 23-02. Its state will be discarded; anything you want to keep must already be out.
```

## Getting the command

The pool is shared by every checkout on the machine: the state is `~/.arashouse/`, whichever checkout's build you run.
If `arashouse` is not on your `PATH`, use an arashouse checkout's built CLI, `<checkout>/dist/cli/index.js`, with
Node 20 or newer. If that file is not there, build the checkout first (`npm ci && npm run build` in it).

An alias works only in an interactive shell, and an agent's tool often starts a fresh shell for every command, so name
the file each time, or keep it in a variable within one command:

```
node <checkout>/dist/cli/index.js status
A="node <checkout>/dist/cli/index.js"; $A get 23 --holder my-task ...
```

This guide writes `arashouse` for it. `arashouse help` lists the commands; `arashouse help <command>` explains one.

## Pick a flavor

For example (the counts are the pool's at that moment):

```
$ arashouse flavors
FLAVOR  RELEASE                BUILD          ENGINE  FREE  LEASED  TOTAL  MEDIA  BASELINE
12sp9   12.0 SP9               12.0.0.24090   12.0    2     1       3      yes    yes
23      Release 23 (14.0 SP9)  14.0.9.36073   14.0.7  1     0       2      yes    yes
35      Release 35 (14.35)     14.35.0.43890  14.35   2     0       2      yes    yes
```

| flavor | Aras | import-export-libs-js engine (`ARAS_PKG_ENGINE`) |
|---|---|---|
| `12sp9` | 12.0 SP9 | `12.0` |
| `23` | Release 23 (14.0 SP9) | `14.0.7` |
| `35` | Release 35 (14.35) | `14.35` |

Pick the flavor of the Aras your work targets. `arashouse status` shows every slot and who holds it.

## 1. Take a lease

```
arashouse get <flavor> --holder <task> --json --password-fd 3 3>/dev/null
```

`--holder` names you (your task or crewmate name; 1 to 500 characters), so the operator can see whose lease it is.
stdout is the lease, as JSON (`docs/schemas/get.schema.json`); for example:

```json
{
  "slot": "23-01",
  "flavor": "23",
  "aras": "14.0.9.36073",
  "engine": "14.0.7",
  "url": "http://172.19.0.1/ah-23-01",
  "database": "arashouse_23_01",
  "user": "root",
  "lease_id": "5a4b206d108d8afcb91a311581cb74cd",
  "holder": "arashouse-48-check"
}
```

Keep the `lease_id`: every later command needs it, and `status` shows only its first 8 characters. Save the JSON to a
file of your own (`> lease.json`; with `--password-fd` it holds no password) rather than only reading it. stderr says
`leased 23-01 to <holder>; return it with: arashouse return <lease_id>`. If you lose the id anyway: find your row in
`arashouse status` (your holder, the `LEASE` column's 8 characters) and the file in `~/.arashouse/leases/` whose name
starts with them; the name is the whole lease id. Read the name only: the file holds the password.

**The password.** Each lease gets its own password for `root` (and `admin`), made at `get` and dead at `return`. You
rarely need to see it: `arashouse run` (below) hands it to your tools, reading it from the lease's file in
`~/.arashouse/leases/` (mode 0600), which `return` deletes. `--password-fd 3 3>/dev/null` writes it to descriptor 3,
here thrown away, so it lands in no transcript or log. Without `--password-fd`, `get --json` prints it
once in the JSON as `password`. Without `--json`, `get` prints the slot, URL, database, user and lease id, and no
password. If you must log in by hand (a browser), take it from that one `get --json` and keep it out of commits, files
and logs.

**When none is free.** `get` exits 3 at once (`no 23 slot is free: ...`, or `max_active 3 reached`). Add
`--wait <seconds>` to queue for one; a slot being reset is usually free within one to three minutes.

## 2. Use it

```
arashouse run --lease <lease_id> -- <command> [args...]
```

Runs the command (no shell, in your current folder, so relative paths are yours) with the lease's connection in its
environment, and only in its environment:

| variable | value |
|---|---|
| `ARAS_URL` | the slot's URL as seen from WSL, such as `http://172.19.0.1/ah-23-01` |
| `ARAS_DATABASE` | `arashouse_<flavor>_<NN>` |
| `ARAS_USER` | `root` |
| `ARAS_PASSWORD` | the lease's password |
| `ARASHOUSE_SLOT`, `ARASHOUSE_FLAVOR` | the slot id, the flavor |
| `ARAS_PKG_ENGINE` | the libs-js engine for the flavor |

import-export-libs-js (`aras-pkg`) reads these, so it needs no flags for the connection:

```
arashouse run --lease <lease_id> -- aras-pkg export ./out ItemType:6DAB4ACC09E6471DB4BDD15F36C3482B
arashouse run --lease <lease_id> -- node <libs-js checkout>/dist/cli.js export ./out --package <name>   # aras-pkg not on PATH
```

The first line exports the out-of-the-box ItemType `Variable` (an id Aras ships in its core; run on a `23`
lease: `result: success`, one item in `com.aras.innovator.core`), a quick check that the export path works. Your own work
names its own items: the ids and package names come from what your task created or imported, or from an AML query of
your own tool (below). arashouse has no query command.

`aras-pkg` is the CLI of import-export-libs-js (Node 20 or newer, no .NET). If it is not on your `PATH`, build a libs-js
checkout (`npm ci && npm run build`) and run its `dist/cli.js` with `node`, as on the second line. `run` starts the
command without a shell, so an alias does not reach it; name the file. aras-pkg writes its log,
`aras-pkg-<command>-<time>.log`, into the current folder.

A tool of your own should read `ARAS_PASSWORD` from its environment, never take it as a flag or from a file; it logs
in as `ARAS_USER` to `ARAS_DATABASE` at `ARAS_URL` as any Aras client does (an OAuth password grant through the
server's `OAuthServerDiscovery.aspx`). For a shell, quote it so the variable is expanded inside the child, not by your
shell:

```
arashouse run --lease <lease_id> -- sh -c 'printenv ARASHOUSE_SLOT ARAS_URL ARAS_DATABASE'
```

`run` passes the command's exit code through. A lease that is not held (returned, or never yours) exits 4.

**Bringing a lease up with your data or code.** `get` can restore a backup, deploy code and import packages before it
hands the lease over, from a **recipe**:

```json
{
  "flavor": "23",
  "restore": "profiles/demo.bak",
  "code": [ { "from": "./overlay", "to": "Innovator/Client" } ],
  "import": [ { "manifest": "./pkgs/imports.mf", "merge": true, "release": "R1" } ],
  "git": true
}
```

```
arashouse get --bootstrap ./recipe.json --holder <task> --json --password-fd 3 3>/dev/null
```

Paths are relative to the recipe file; every section is optional; the order is fixed (restore, code, import, git, then
a health check). The recipe is checked before a slot is taken, so a bad path costs no slot. A step that fails returns
the lease and exits 9, naming the step and its log; `--keep-on-fail` keeps it so you can look. A recipe never holds a
secret: a key named like `password`, `key` or `token` is refused. `arashouse bootstrap --lease <lease_id> <recipe>`
applies one to a lease you already hold. The whole of it, with a worked example measured on all three flavors, is
`docs/bootstrap.md`; the single steps are `get --restore` (`docs/restore.md`), `get --code` and `deploy-code`
(`docs/code-deploy.md`), `get --import` and `import` (`docs/import.md`) and `get --git` (`docs/git-baseline.md`).

## 3. Take out what you want to keep

Before you return. Three kinds of thing (`docs/extract.md`):

| what | command |
|---|---|
| packages and items | `arashouse run --lease <lease_id> -- aras-pkg export <dir> ...` (`--package <name>`, `--use-import <imports.mf>`, `--from-manifest <imports.mf>`, `--all-packages`, or `Type:<id>` items) |
| code: a file or folder of the slot's tree | `arashouse extract code --lease <lease_id> <path> --to <dir>` |
| data: the slot's database | `arashouse extract db --lease <lease_id> --to <file.bak>` |

```
$ arashouse extract code --lease <lease_id> Innovator/Client/web.config --to ./out
extracted 1 file (0.0 MB) from 23-01:Innovator/Client/web.config to /home/me/work/out/web.config
$ arashouse extract db --lease <lease_id> --to ./backups/23.bak
extracted the database of 23-01 (COPY_ONLY backup, 82.1 MB) to /home/me/work/backups/23.bak
```

- `extract code` takes a path relative to the slot folder (`Innovator/Client/javascript`,
  `Innovator/Server/bin/MyLib.dll`) and copies it to `<dir>/<its name>`. It never replaces a file, follows a link,
  or leaves the slot's folder (exit 7). Config and key files (`InnovatorServerConfig.xml`, `*.pfx`, `key-*.xml`, ...)
  hold the slot's secrets and are refused unless `--allow-config`; you rarely want them. Copies keep their file times;
  their modes come from Windows through WSL (read-only and executable, for example), so `chmod` them before you edit
  them.
- `extract db` writes a normal SQL Server backup (82 MB for an untouched `23`) to a file that must not exist yet, in a
  folder that must. Keep it in a folder of its own, not beside files you commit. `get --restore <file.bak>` (or a recipe's `restore`) brings it back
  on a later lease of the same flavor: that is how you carry data from one lease to the next.
- `arashouse status --json` shows `extracted: true` on your slot once an `extract` ran. It is a note only: nothing
  checks it, and `return` discards the slot either way.

Commit or copy the extracted files where they belong (your repo, your task's output folder). Never commit a password,
a licence key, or a config file you took out with `--allow-config`.

## 4. Give it back

```
arashouse return <lease_id>
arashouse return <slot> --if-lease-id <lease_id>     # the same, by slot name
```

It exits at once (0), printing `returned 23-01; it is reset before it is handed out again`; the slot is reset in the
background and handed to nobody until it is clean. In `status` your slot then shows `dirty`, then `resetting`, then
`free` (one to three minutes; nothing for you to wait for). Your part is done when `return` exits 0: `run` on the
lease now exits 4. Returning twice is
fine (`already returned`, exit 0). By slot name the lease id is required, and a lease id the slot no longer holds
exits 4 and changes nothing, so a stale script can never return someone else's lease. `--quiet` leaves out the
reminder line; `--wait` blocks until the slot is free again (for scripts that want to know).

Return your lease when your task ends, also when it fails. There is no expiry: a lease you forget holds a slot, and
one of the `max_active` places (3 by default), until the operator ends it.

## Exit codes

From `src/core/exit-codes.ts` (the full table, with every command's cases, is in `docs/cli.md`):

| code | meaning | what to do |
|---|---|---|
| 0 | ok (including `already returned`) | |
| 1 | any other failure | read the message |
| 2 | usage: unknown command, option or flavor; `return` by slot name without `--if-lease-id`; a bad recipe | fix the command |
| 3 | no slot available (none free, or `max_active` / the RAM gate) | `--wait <seconds>`, or try later |
| 4 | the lease is not held (returned, or someone else's), or its password file in `~/.arashouse/leases/` is gone | `arashouse status`; take a new lease |
| 5 | a reset failed: the slot is quarantined, or `return --wait` timed out | nothing for you; the operator repairs it |
| 6 | the host or broker did not answer | try again; if it persists, tell the operator |
| 7 | refused by a guard (a name arashouse does not own, a path outside the slot, a config file) | the message says which |
| 8 | a step needs a secret and no terminal can ask | the operator's |
| 9 | an import, or a bootstrap step, failed | read the log the message names |
| 10 | a code deploy or git baseline failed after the lease was taken; the lease is still yours unless `--atomic` | read the message; return the lease |
| 127 | `run` could not start the command | check the command's path |

`run` passes its command's own exit code through, so those can collide with these.

## Never

- **Never contact olm, prod, `OLM_Local` or the captain's own Aras installs.** A lease is the only Aras arashouse
  gives you; use its `ARAS_URL` and `ARAS_DATABASE`. arashouse refuses any other name (exit 7).
- **Never put a password in a flag, a file, a commit or a log.** Pass it through `arashouse run`'s environment. A
  recipe holds no secrets.
- **Never hold a lease across sessions.** Return it before your session ends; the next session takes a new one (it is
  clean, which is the point). Carry state between them by extracting it and bringing it back with a recipe.
- **Never rely on a returned slot.** Not its data, not its files, not its URL: the next holder gets the slot reset.
- **Never ask arashouse to keep a lease's state.** It has no way to, by design.

## A block for another repo's `AGENTS.md`

Paste this into a repo whose workers need a live Aras:

```markdown
## Live Aras: an arashouse lease

Use an `arashouse` lease: a disposable, clean Aras instance of one version, leased like a worktree.
Worker guide: `docs/using-a-lease.md` in the arashouse repo.

- Take: `arashouse get <12sp9|23|35> --holder <task> --json --password-fd 3 3>/dev/null`; keep the `lease_id`.
- Use: `arashouse run --lease <lease_id> -- <command>`; the connection is in `ARAS_URL`, `ARAS_DATABASE`, `ARAS_USER`,
  `ARAS_PASSWORD` and `ARAS_PKG_ENGINE`, for that command only.
- Take out what you want to keep before returning: `arashouse run --lease <id> -- aras-pkg export <dir> ...`,
  `arashouse extract code --lease <id> <path> --to <dir>`, `arashouse extract db --lease <id> --to <file.bak>`.
- Give back: `arashouse return <lease_id>` when the task ends, also when it fails. A returned lease is discarded;
  assume it is gone. Never hold a lease across sessions.
- Never contact olm or prod. Never put the password in a flag, a file, a commit or a log.
```
