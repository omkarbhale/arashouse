# The `arashouse` CLI

The worker-facing commands, thin over the lease core (`docs/lease.md`), and the operator commands,
thin over `src/core/operator.ts`. Source: `src/cli/commands.ts`. `get --bootstrap` and its steps are
tickets 39 to 42 (the code deploy, `get --code` and `deploy-code`, ticket 40, is in `docs/code-deploy.md`; `get --import` and
`import`, ticket 41, are in `docs/import.md`); the extraction helpers (`extract`, ticket 43) are in `docs/extract.md`.

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever
> took the lease before giving it back."

## Commands

| command | what it does |
|---|---|
| `arashouse get <flavor> --holder <task> [--wait <seconds>] [--agent] [--json] [--password-fd <n>] [--code <dir\|zip>[:<subpath>]]... [--allow-config] [--allow-servers] [--atomic]` | Leases a clean slot of the flavor; `--agent` starts its agent service too; `--password-fd` writes the password to a descriptor; `--code` deploys code into it (`docs/code-deploy.md`). |
| `arashouse deploy-code --lease <lease_id> <dir\|zip>[:<subpath>]... [--allow-config] [--allow-servers] [--json]` | Deploys a folder or zip over a leased slot's tree (`docs/code-deploy.md`). |
| `arashouse get <flavor> --holder <task> --import <manifest\|folder> [<import options>] ... [--keep-on-fail]` | The same, then imports package manifests onto the lease with import-export-libs-js, in order (`docs/import.md`). |
| `arashouse import --lease <lease_id> <manifest\|folder> [<import options>] ...` | Imports package manifests onto a held lease (`docs/import.md`). |
| `arashouse return <lease_id> [--wait[=<seconds>]] [--quiet]` | Gives the lease back; its slot is discarded. |
| `arashouse return <slot> --if-lease-id <lease_id> [--wait[=<seconds>]] [--quiet]` | The same, by slot name; the lease id is required (ABA protection). |
| `arashouse status [--json]` | Every slot, its holder and lease age, totals per flavor, `max_active` in use. |
| `arashouse flavors [--json]` | Each flavor's release, build, libs-js engine, slot counts, media and baseline. |
| `arashouse run --lease <lease_id> -- <command ...>` | Runs a command with the lease's connection in its environment. |
| `arashouse extract code --lease <lease_id> <path> --to <dir> [--allow-config]` | Copies a file or folder of the slot's tree out of the lease (`docs/extract.md`). |
| `arashouse extract db --lease <lease_id> --to <file.bak>` | Writes a `COPY_ONLY` backup of the slot's database out of the lease (`docs/extract.md`). |
| `arashouse media check [<flavor>...] [--json] [--write-sums]` | Checks the installers (`docs/media-check.md`). |
| `arashouse baseline verify <flavor> [--full] [--json]` | Checks the flavor's golden against its manifest, through the broker; exit 1 when it does not verify (`docs/baselines.md`). |
| `arashouse reset-worker [--slot <slot>]` | Resets returned slots; `return` starts it detached (`docs/reset.md`). |
| `arashouse setup [--out <dir>]` | Writes the one-time host setup script, which the captain runs elevated (`docs/setup.md`). |
| `arashouse setup-sql [--out <dir>]` | Writes the one-time SQL Server setup script, which a `sysadmin` login runs (`docs/setup-sql.md`). |
| `arashouse baseline build <flavor> [--replace] [--engine-check <dir>]` | Checks the media and writes the script that builds the flavor's golden, which the captain runs elevated; `--replace` marks the flavor's free slots dirty first; `--engine-check` bundles a built import-export-libs-js checkout, so the build also exports one item with the flavor's engine (`docs/baselines.md`). |
| `arashouse doctor [--fix] [--rebuild-state] [--deep] [--yes] [--json]` | Checks the pool against the host; see [Operator commands](#operator-commands). |
| `arashouse provision <flavor> [<count>]` | Makes the flavor's slots `01` to `<count>` from its golden on the host (`docs/provision.md`). |
| `arashouse repair <slot> [--rebuild]` | Resets a quarantined slot from golden; the way out of `quarantined`. |
| `arashouse destroy <slot> [--yes] [--include-leased]` | Removes a slot from the host and the pool. |
| `arashouse prune [--yes]` | Destroys the `disabled` and orphaned slots. |
| `arashouse teardown [--goldens] [--keep-sql] [--remove-root] [--include-leased <slot>...] [--yes] [--out <dir>]` | Removes the whole pool, then writes the script the captain runs elevated to remove the SQL objects, the broker and (as asked) the goldens and the root (`docs/teardown.md`). |
| `arashouse force-return <slot> --lease-id <lease> [--yes]` | Returns the lease of a holder that crashed. |
| `arashouse disable <slot>`, `arashouse enable <slot>` | Takes a slot out of rotation, or puts it back. |
| `arashouse help [<command>]`, `<command> --help` | Help for the tool or one command. |
| `arashouse version`, `--version` | The package version. |

`--verbose` is accepted by every command: it adds detail on stderr (which host, where the state is)
and never a secret.

### `get`

`--holder` names who takes the lease (a task or crewmate name); two `get` calls from one holder get
two slots. `--wait <seconds>` waits up to that long for a slot; without it a flavor with no free slot
exits 3 at once. With no free slot but a dirty one, `get --wait` resets it itself (about 10 s, and it
finishes the reset even past the deadline); without `--wait` it starts a reset worker for it and
exits 3 (`docs/reset.md`).

`--agent` also starts the slot's agent service (`ArasHouseAgent_<key>_<NN>`, on the slot's reserved port), which
conversion tasks and scheduled methods need; without it the agent stays stopped. The reset stops it again. A slot
made from a golden built before ticket 33b has no agent: `get --agent` is then refused (exit 7) and the slot it took
goes back to be reset (`docs/start-stop.md`).

With `--json`, stdout is the lease contract and nothing else (`docs/schemas/get.schema.json`); any
human text goes to stderr. It is the one output that shows the lease's password, once. There is no
`--password-stdout`. Without `--json`, `get` prints the slot, URL, database, user and lease id, and
not the password: reach it through `run`. The password is `root`'s and `admin`'s on the slot, and dies
with the lease (`docs/lease-credentials.md`).

`--password-fd <n>` writes the password and a newline to descriptor `<n>` instead, for a caller that
does not want it on stdout (`arashouse get 23 --holder t --json --password-fd 3 3>pw`); `--json` then
leaves `password` out. `<n>` is 3 or more and must be one the command inherited: 0 to 2 are refused,
and so is a descriptor that is not open or is Node's own (its event loop opens descriptors from the
lowest free number, so one the caller did not open is never written to). It is checked before the
lease is taken, so a mistake costs no slot (exit 2). If the write fails after the lease is taken, the
lease is returned at once.

`--code <dir|zip>[:<subpath>]` (repeatable, applied in order, before any `--import`) deploys code into the slot once it is leased, as
`deploy-code` does (`docs/code-deploy.md`). Each source is read and checked before the lease is taken, so a deploy a
guard refuses costs no slot (exit 7). If a deploy fails after the lease is taken, the lease is still held: `get` prints
it as usual (with `bootstrap.code` in the JSON saying what failed) and exits 10; no `--import` runs. With `--atomic` it
returns the lease instead (the reset removes whatever was deployed) and exits 10 without printing one. `--allow-config`,
`--allow-servers` and `--atomic` go only with `--code`.

### `deploy-code`

`arashouse deploy-code --lease <lease_id> <dir|zip>[:<subpath>]...` deploys onto a lease already held: each source
is staged, copied over the slot's tree and the slot started again, in order (`docs/code-deploy.md`). With `--json`,
stdout is `{ slot, code }` (`docs/schemas/deploy-code.schema.json`). A lease that is not held exits 4; a deploy a
guard refuses exits 7 and changes nothing; one that fails after it started exits 10, the lease still held.

`--import <manifest|folder>` (repeatable) imports each package manifest onto the lease after it is taken, in
order, with import-export-libs-js's `aras-pkg import` and the flavor's engine; the options after an `--import`
are that import's. A failed import returns the lease and exits 9; `--keep-on-fail` keeps it and prints it
(still exit 9). With `--json` the contract gains `imports`, one `{ manifest, exit_code, log }` per import that
ran. See `docs/import.md`.

### `import`

`arashouse import --lease <lease_id> <manifest|folder> [<import options>] ...` is `get --import` for a lease
already held: the same options, the same child process, logs numbered after the lease's earlier ones. A
failed import exits 9 and the lease is kept. A lease that is not held exits 4, as with `run`.

### `return`

Marks the slot dirty, starts a detached `reset-worker` for it and exits; it does not wait for the
reset unless `--wait` is given. The worker
may assume the slot is clean from then on: arashouse does not hand it out again until it is. Returning
twice is a no-op (exit 0, `already returned`). `--wait` blocks until the slot is free again, with no
limit; `--wait=<seconds>` sets one. Only the `=` form takes a value, so the lease id after `--wait` is
never read as seconds.

It reminds the holder on stderr, in one line and with no prompt or delay: `Returning slot 23-02. Its state will be
discarded; anything you want to keep must already be out.` `--quiet` leaves the line out; a repeated return prints
none. Take things out first with `arashouse extract` or `run ... aras-pkg export` (`docs/extract.md`).

### `reset-worker`

`arashouse reset-worker [--slot <slot>]` resets `<slot>`, then every other dirty slot it can, and prints
one line per slot (`23-01 reset in 9.8 s; free`). `return` starts it detached with no output; it is not
needed by hand. It exits 5 if the named slot was quarantined and 6 if the host did not answer.
`ARASHOUSE_RESET_WORKER=off` stops `return` and `get` from starting one (a lazy reset in `get --wait`
still runs). See `docs/reset.md`.

### `run`

Starts the command (in WSL, without a shell) with these variables added to the environment of that
child only:

| variable | value |
|---|---|
| `ARAS_URL` | the slot's URL as seen from WSL, for example `http://172.19.0.1/ah-23-01` |
| `ARAS_DATABASE` | `arashouse_<flavor>_<NN>` |
| `ARAS_USER` | `root` |
| `ARAS_PASSWORD` | the lease's password |
| `ARASHOUSE_SLOT` | the slot id, for example `23-01` |
| `ARASHOUSE_FLAVOR` | the flavor key |
| `ARAS_PKG_ENGINE` | the import-export-libs-js engine for the flavor (`12.0`, `14.0.7`, `14.35`) |

So `arashouse run --lease <lease_id> -- aras-pkg export ./out Item:<id>` works with no glue: libs-js
reads these variables, and its rule is that "the password reaches tools only through the environment
(`ARAS_PASSWORD`) or stdin, never through a flag or a file". `run` does not echo the environment.

The password is read from the lease file `$ARASHOUSE_HOME/leases/<lease_id>` (mode 0600, in a 0700
folder), which `get` writes and `return` deletes; it is the only secret the WSL side keeps
(`docs/secrets.md`). A lease that is not `leased` (returned, or unknown) exits 4. So does a lease whose
password file is gone (after a state recovery): return it and take a new one.

The command's exit code is passed through, so it can collide with the codes below; a command killed
by a signal exits 128 plus the signal number, and one that cannot be started exits 127. Ctrl-C reaches
the command, and `run` waits for it to exit; `SIGTERM` and `SIGHUP` are forwarded to it.

### `flavors --json`

`docs/schemas/flavors.schema.json`: one entry per flavor with `flavor`, `release`, `aras` (the server
build from the registry; null when it is not known), `engine`, `slots` (`free`, `leased`, `total`), `media` (every
expected installer file is in `media/<flavor>/`, loose or inside a CD-image zip; null when the media
folder cannot be found) and `baseline` (the golden verifies at the fast level; null when the host could
not be asked). `media` reads only zip directories; `media check` is the full check.

### `status`

`status --json` also shows, per slot, `extracted`: whether an `arashouse extract` ran against its lease (`null` with no
lease). It is information only (`docs/extract.md`).

One row per slot, then totals per flavor, `max_active` and `max_resets` in use, and the `get --wait`
queue. A lease held 24 hours or more shows `old` after its age, with a line naming the slot, its
holder and the `force-return` that would end it. Nothing reclaims an old lease: there is no lease
expiry (the captain's answer 5).

## Operator commands

What a person, or firstmate, uses when something is wrong. Source: `src/core/operator.ts`.

- **Destructive commands are dry runs unless `--yes` is given**: `destroy`, `prune`, `teardown`, `force-return`,
  the orphan removal of `doctor --fix` and `doctor --rebuild-state`. A dry run prints what it would do
  and `dry run: nothing was changed; run again with --yes to do it`, and exits 0.
- **A command names a slot only by its id** (`23-01`, as `status` shows it). A deny-listed name
  (`OLM_Local`, `12sp9`, `InnovatorServer23`, anything containing `olm` or `prod`, a path of the
  captain's installs) is refused with exit 7 before the state or the host is read; anything else that
  is not a slot id is exit 2. `doctor` and `prune` act only on the slots the host lists as the tool's
  own, after each listed entry parses back to a slot id; any other entry is counted and ignored.
- A command refused because of the slot's status (destroying a leased slot, disabling one being
  reset, repairing one that is not quarantined) exits 7 and changes nothing.

### `doctor [--fix] [--rebuild-state] [--deep] [--yes] [--json]`

One line per check, `ok`, `warn` or `fail`, then a summary; it exits 1 when a check failed and was
not fixed, else 0. A host-wide setting that would help the pool is an `advice` line (the value seen, the value
recommended, and why); advice is the operator's choice, never a failure or a warning, and never changes the exit
code (ticket 55, `docs/host-tuning.md`). With `--json` it prints `{ ok, exitCode, findings }` instead, each finding
`{ level, check, message }` (plus `fixed` and `resolved` when `--fix` acted), with the same exit
code. It checks:

| check | fails or warns when |
|---|---|
| `state` | the state file is unusable |
| `setup` | the install root is missing, `setup-host.ps1` has not been applied (no `broker\setup-host.json`), or its last run did not finish (a folder's ACL, the root's ACL, the broker service); only with the broker host (`docs/setup.md`) |
| `prerequisites` | the last setup run found a prerequisite of a flavor in `media/` missing (warn) |
| `setup acl` | from WSL, the worker can list a folder it should be kept out of (`secrets\`, `golden\`, ...) or cannot list `slots\`, `staging\` or `broker\` |
| `broker` | the broker does not answer `ping` (the host checks below are then skipped) |
| `sql` | the broker cannot connect to SQL Server with its login (`docs/setup-sql.md`) |
| `sql login` | the broker's SQL login is in `sysadmin` or `dbcreator`, or cannot execute all five `arashouse_admin` procedures; warns when the broker predates ticket 22 and does not report them |
| `disk`, `ram` | free disk is under `min_free_disk_gb`, free RAM under `min_free_ram_mb` (warn; `docs/governor.md`) |
| `media <flavor>` | the flavor's media is missing or its folder cannot be found (warn; `media check` is the full check) |
| `baseline <flavor>` | the golden does not verify at the fast level (the full level, every file's SHA-256, with `--deep`): fail if the pool has slots of the flavor, else warn |
| `aras-pkg` | the import tool (`$ARASHOUSE_APKG`, else `aras-pkg` on `PATH`) is not there or does not answer `--version` (warn; only `get --import` and `import` need it); when it is there, the line names where it came from and its version |
| `slot <id>` | a record whose slot is not on the host; a stamp that belongs to another slot; a `free` slot that is not clean on the host (its stamp, tree, database marker or health; the same check `get` makes), unless a `get` leased it or a reset ran since doctor read the state (ok); a `resetting` slot whose worker has ended; a `dirty` slot with no reset running (warn); a `quarantined` slot (warn); a lease 24 hours old or more (warn); a lease the stamp does not name (warn) |
| `orphan <id>` | a slot on the host with no record (`arashouse_*` database, `ah-*` application) |
| `sql max server memory` | advice only: SQL Server's `max server memory` is uncapped (its default); a 4096 MB cap is suggested |
| `wsl memory` | advice only: run from WSL, when Windows has less free RAM than the leases still to come up to `max_active` need (`min_free_ram_mb` each), the WSL VM cap that would give the shortfall back |

`--fix` re-starts resets: a `resetting` slot whose worker has ended goes back to `dirty`, a `free`
slot that is not clean goes to `dirty`, and each gets a reset worker, as does a `dirty` slot nothing
is resetting. With `--yes` it also destroys orphans (only what the tool created, and never one whose
stamp names a lease). `--rebuild-state` rebuilds the state from the slot stamps (ticket 11's recovery,
`src/core/recovery.ts`): a slot whose stamp names a lease comes back `leased` to `unknown (recovered)`,
every other slot `dirty`. Without `--yes` it says what the rebuilt state would hold; with it the old
file is set aside as `state.json.corrupt-<time>`.

### `provision <flavor> [<count>]`

Makes sure the pool holds the flavor's slots `01` to `<count>` (default: `slots_per_flavor` in the
config, `docs/governor.md`), in order, behind the disk gate (`min_free_disk_gb`, exit 7). Each slot
not in the pool gets a `provisioning` record and is made on the host from the flavor's golden
(`provisionSlot`: folders, IIS application and pools, agent, database and logins, rendered configs,
stamp; `docs/provision.md`). A slot already in the pool is left alone (`23-01 is in the pool already
(free)`), and one an earlier run left `provisioning` is finished. After its provision the slot's health
check decides: `free` when it passes, `quarantined` when it fails, `dirty` (with a reset worker) when it
cannot run. A slot whose provision fails was rolled back by the host: its record is removed (or the
slot quarantined if the host still lists it) and the run stops there with that error; when the host did
not answer, the record stays `provisioning` and running `provision` again finishes it. Only one
`provision` runs at a time (`provision.lock` next to the state file). A flavor key comes first: `12sp9`
is a flavor here, though the deny-list also holds it as a database name.

### `repair <slot> [--rebuild]`

The way out of `quarantined`, and only for a quarantined slot. It moves the slot to `dirty` and runs
the reset sequence in this process (`docs/reset.md`: database and tree from golden, start, health),
so the slot ends `free`, or `quarantined` again with exit 5. `--rebuild` first recreates the slot's
IIS application, database shell and folders (`destroySlot`, then `provisionSlot`, ticket 25), behind
the disk gate (`min_free_disk_gb`, exit 7); a failed rebuild quarantines the slot with the reason.
A quarantined slot holds no lease, so `repair` needs no `--yes`.

### `destroy <slot> [--yes] [--include-leased]`

Removes the slot's record and, through the broker, its application, app pools, agent service,
folders and database. A leased slot is refused unless `--include-leased` is given with its exact
name; its lease is lost and its password file deleted. A slot whose reset is running is refused. A
slot that is only on the host (an orphan) can be destroyed by name. If the host fails after the
record is removed, the slot is left as an orphan that `destroy <slot> --yes` removes.

### `prune [--yes]`

Lists, and with `--yes` destroys, the slots that are `disabled` and the orphans. **Not by age**: a
lease has no expiry. An orphan whose stamp names a lease is listed and left alone. A slot that was
enabled, or given a record, after it was listed is skipped.

### `teardown [--goldens] [--keep-sql] [--remove-root] [--include-leased <slot>...] [--yes] [--out <dir>]`

Removes the whole pool (ticket 49, `docs/teardown.md`). It destroys every slot, the state's and the
orphans the host lists, as `destroy` does one, and writes `teardown.ps1` to `<dir>` (default:
`arashouse-teardown` in the Windows temp folder) for the captain to run elevated. A leased slot is refused
(exit 7) unless every leased slot is named after `--include-leased`; naming one that is not leased is
exit 2. A slot whose reset is running is refused. Both refusals come before anything is destroyed. With
`--yes` the bundle is written first, so a failure there changes nothing. `--remove-root` needs
`--goldens` and does not go with `--keep-sql` (exit 2).

### `force-return <slot> --lease-id <lease> [--yes]`

The operator's `return`, for a holder that crashed. `<lease>` is the `LEASE` column of `status`
(the lease id's first 8 characters) or the whole lease id. If the slot now holds a different lease
it exits 4 and changes nothing, so it cannot hit a later lease of the same slot. It dirties the slot
like `return`, deletes the lease's password file and starts a reset worker. A slot that is not
leased is a no-op (exit 0).

### `disable <slot>`, `enable <slot>`

`disable` takes a slot out of rotation (`free`, `dirty`, `quarantined` or `provisioning` to
`disabled`) and stops it on the host, to give its RAM back; a leased slot or one being reset is
refused. `enable` sends a disabled slot to `dirty`, so it is reset before it is handed out.

## Output rules

- No command prints a password except `get --json`, once (or `get --password-fd`, to its descriptor). `--verbose` never adds a secret.
- An error is one line on stderr, `arashouse: <message>`, then a `hint:` line. Every message passes
  through `redact`. The stack is printed only when `ARASHOUSE_DEBUG=1`.
- JSON goes to stdout, pretty-printed; human notes that accompany JSON go to stderr.

## Exit codes

Stable. `src/core/exit-codes.ts` is the source; `test/cli.test.ts` checks this table lists each code.

| code | meaning |
|---|---|
| 0 | ok (including `already returned`) |
| 1 | any other failure; `doctor` found a check that failed and was not fixed |
| 2 | usage: an unknown command, option or flavor, a missing argument, `return` by slot name without `--if-lease-id`, a slot that is not a slot id, `teardown` options that do not go together |
| 3 | no slot available: none of the flavor is free, or the governor refused (`max_active`, `min_free_ram_mb`; `docs/governor.md`) |
| 4 | lease mismatch: `return --if-lease-id` or `force-return --lease-id` named a lease the slot no longer holds; `run` on a lease that is not held, or whose password is gone |
| 5 | reset failed: the slot is quarantined or disabled, or `return --wait` timed out; `reset-worker` or `repair` quarantined its slot |
| 6 | host unreachable (the host or broker did not answer) |
| 7 | refused by a guard: the name is not one arashouse owns, or is on the deny-list; or an operator command the slot's status does not allow (destroying a leased slot, a `teardown` while a slot is leased, repairing one that is not quarantined), or `repair --rebuild` under the disk gate |
| 8 | a step needs a secret and no terminal can ask for it |
| 9 | an import failed: `aras-pkg import` exited non-zero in `get --import` (the lease was returned, unless `--keep-on-fail`) or `import` (the lease is kept); stderr names its exit code and log |
| 10 | a code deploy (`get --code`, `deploy-code`; `docs/code-deploy.md`) failed after the lease was taken: the lease is still held (`get` still prints it), unless `get --atomic` returned it |
| 127 | `run` could not start its command |

## Environment

| variable | effect |
|---|---|
| `ARASHOUSE_HOME` | the state folder (default `~/.arashouse`): `state.json`, `events.log`, `leases/` |
| `ARASHOUSE_HOST` | `broker` (default) or `fake`. `broker` is `BrokerHost` (`docs/broker.md`): until the broker is installed (`arashouse setup`, ticket 21) every host call exits 6, and so does a call whose verb the broker does not have yet. `fake` is the offline fake host, rebuilt in each process from the state file (each slot clean, each baseline built; none when the file is unusable); the CLI tests use it. |
| `ARASHOUSE_WINDOWS_NODE` | the Windows `node.exe` that runs the broker client, as a WSL path (default `/mnt/c/Program Files/nodejs/node.exe`) |
| `ARASHOUSE_FAKE_FAULTS` | with the fake host: a JSON array of faults to inject (`src/host/fake.ts`, `Fault`), for tests |
| `ARASHOUSE_HOST_ADDR` | the Windows host address for slot URLs (`docs/slot-url.md`) |
| `ARASHOUSE_RESET_WORKER` | `off`: `return` and `get` start no detached reset worker (a lazy reset in `get --wait` still runs); the CLI tests use it |
| `ARASHOUSE_MEDIA` | the folder holding `media/<flavor>/` (`docs/media-check.md`) |
| `ARASHOUSE_APKG` | the import-export-libs-js CLI for `get --import` and `import`: a checkout's `dist/cli.js` (run with this Node) or an executable; else `aras-pkg` on `PATH` (`docs/import.md`) |
| `ARASHOUSE_DEBUG` | `1` prints the stack of an error |
| `ARASHOUSE_LOCAL_ROOT` | the install root as the CLI opens it, for staging a code deploy (default `/mnt/c/aras_installations`); the CLI tests point it at a folder |
