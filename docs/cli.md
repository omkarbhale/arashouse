# The `arashouse` CLI

The worker-facing commands, thin over the lease core (`docs/lease.md`). Source: `src/cli/commands.ts`.
Operator commands (`doctor`, `repair`, `destroy`, `prune`, `force-return`, `disable`) are ticket 16;
`get --bootstrap` and its steps are tickets 39 to 42; the extraction helpers are ticket 43.

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever
> took the lease before giving it back."

## Commands

| command | what it does |
|---|---|
| `arashouse get <flavor> --holder <task> [--wait <seconds>] [--json]` | Leases a clean slot of the flavor. |
| `arashouse return <lease_id> [--wait[=<seconds>]]` | Gives the lease back; its slot is discarded. |
| `arashouse return <slot> --if-lease-id <lease_id> [--wait[=<seconds>]]` | The same, by slot name; the lease id is required (ABA protection). |
| `arashouse status [--json]` | Every slot, its holder and lease age, totals per flavor, `max_active` in use. |
| `arashouse flavors [--json]` | Each flavor's release, build, libs-js engine, slot counts, media and baseline. |
| `arashouse run --lease <lease_id> -- <command ...>` | Runs a command with the lease's connection in its environment. |
| `arashouse media check [<flavor>...] [--json] [--write-sums]` | Checks the installers (`docs/media-check.md`). |
| `arashouse reset-worker [--slot <slot>]` | Resets returned slots; `return` starts it detached (`docs/reset.md`). |
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

With `--json`, stdout is the lease contract and nothing else (`docs/schemas/get.schema.json`); any
human text goes to stderr. It is the one output that shows the lease's password, once. There is no
`--password-stdout`. Without `--json`, `get` prints the slot, URL, database, user and lease id, and
not the password: reach it through `run`.

### `return`

Marks the slot dirty, starts a detached `reset-worker` for it and exits; it does not wait for the
reset unless `--wait` is given. The worker
may assume the slot is clean from then on: arashouse does not hand it out again until it is. Returning
twice is a no-op (exit 0, `already returned`). `--wait` blocks until the slot is free again, with no
limit; `--wait=<seconds>` sets one. Only the `=` form takes a value, so the lease id after `--wait` is
never read as seconds.

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
build; null until the baseline is built), `engine`, `slots` (`free`, `leased`, `total`), `media` (every
expected installer file is in `media/<flavor>/`, loose or inside a CD-image zip; null when the media
folder cannot be found) and `baseline` (the golden verifies at the fast level; null when the host could
not be asked). `media` reads only zip directories; `media check` is the full check.

## Output rules

- No command prints a password except `get --json`, once. `--verbose` never adds a secret.
- An error is one line on stderr, `arashouse: <message>`, then a `hint:` line. Every message passes
  through `redact`. The stack is printed only when `ARASHOUSE_DEBUG=1`.
- JSON goes to stdout, pretty-printed; human notes that accompany JSON go to stderr.

## Exit codes

Stable. `src/core/exit-codes.ts` is the source; `test/cli.test.ts` checks this table lists each code.

| code | meaning |
|---|---|
| 0 | ok (including `already returned`) |
| 1 | any other failure |
| 2 | usage: an unknown command, option or flavor, a missing argument, `return` by slot name without `--if-lease-id` |
| 3 | no slot available: none of the flavor is free, or the governor refused (`max_active`, `min_free_ram_mb`; `docs/governor.md`) |
| 4 | lease mismatch: `return --if-lease-id` named a lease the slot no longer holds; `run` on a lease that is not held, or whose password is gone |
| 5 | reset failed: the slot is quarantined or disabled, or `return --wait` timed out; `reset-worker` quarantined its slot |
| 6 | host unreachable (the host or broker did not answer) |
| 7 | refused by a guard: the name is not one arashouse owns, or is on the deny-list |
| 8 | a step needs a secret and no terminal can ask for it |
| 127 | `run` could not start its command |

## Environment

| variable | effect |
|---|---|
| `ARASHOUSE_HOME` | the state folder (default `~/.arashouse`): `state.json`, `events.log`, `leases/` |
| `ARASHOUSE_HOST` | `broker` (default) or `fake`. The broker client is tickets 20 and 21; until then every host call exits 6. `fake` is the offline fake host, rebuilt in each process from the state file (each slot clean, each baseline built); the CLI tests use it. |
| `ARASHOUSE_FAKE_FAULTS` | with the fake host: a JSON array of faults to inject (`src/host/fake.ts`, `Fault`), for tests |
| `ARASHOUSE_HOST_ADDR` | the Windows host address for slot URLs (`docs/slot-url.md`) |
| `ARASHOUSE_RESET_WORKER` | `off`: `return` and `get` start no detached reset worker (a lazy reset in `get --wait` still runs); the CLI tests use it |
| `ARASHOUSE_MEDIA` | the folder holding `media/<flavor>/` (`docs/media-check.md`) |
| `ARASHOUSE_DEBUG` | `1` prints the stack of an error |
