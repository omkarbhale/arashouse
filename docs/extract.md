# Taking things out of a lease: `arashouse extract`

Ticket 43. The captain's principle:

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever took the lease
> before giving it back."

`return` discards the slot, and arashouse keeps nothing of it. So before returning, the leaseholder copies out what it
needs. Three helpers cover the three kinds of thing a lease holds. Source: `src/cli/extract.ts`, `src/core/extract.ts`,
the broker's `backupDatabase` verb in `src/broker/backup-database.ts`.

| what | how | where it goes |
|---|---|---|
| packages and items | `arashouse run --lease <id> -- aras-pkg export <dir> ...` (libs-js, ticket 15) | `<dir>` |
| code (files of the slot's tree) | `arashouse extract code --lease <id> <path> --to <dir>` | `<dir>/<name of path>` |
| data (the slot's database) | `arashouse extract db --lease <id> --to <file.bak>` | `<file.bak>` |

Each `extract` marks the lease `extracted` in the state: `status --json` shows `extracted: true` on its slot's row
(`false` for a lease nothing was extracted from, `null` for a slot with no lease), and the events log has a
`lease-extracted` line. That is information only: it gates nothing, and the reset happens either way.

## Packages and items

libs-js does the export; `run` gives it the lease's connection in its environment (`docs/cli.md`), so no password is
typed or passed:

```
arashouse run --lease <id> -- aras-pkg export ./out ItemType:<id> Method:<id>    # these items, with their packages
arashouse run --lease <id> -- aras-pkg export ./out --package <name>             # whole packages
arashouse run --lease <id> -- aras-pkg export ./out --use-import <imports.mf>    # the items that manifest's package folders would add
arashouse run --lease <id> -- aras-pkg export ./out --from-manifest <imports.mf> # all elements of the packages that manifest names
arashouse run --lease <id> -- aras-pkg export ./out --all-packages               # every package in the database
```

`ARAS_PKG_ENGINE` is the flavor's engine, so `--engine` can be left out. These modes are libs-js's (its `README.md`,
`aras-pkg export`); `--use-import`, `--from-manifest` and `--all-packages` are the three selections of Aras's own
console tool.

## Code: `extract code`

```
arashouse extract code --lease <id> <path in the slot> --to <dir> [--allow-config]
```

Copies a file or folder of the slot's tree to `<dir>/<its name>` (`<dir>/<slot id>` for the whole slot folder, `.`),
creating `<dir>`. The path is relative to the slot folder, `/` or `\` separated: `Innovator/Client/javascript`,
`Innovator/Server/bin/MyLib.dll`. File times are kept.

The CLI's Windows process reads the tree through the worker's read grant on `slots\` (ticket 21,
`C:\aras_installations\slots\<key>\<NN>\...`); no broker verb is involved. `--to` is a Windows or relative path, or from
WSL a WSL path, which the Windows process writes through `\\wsl.localhost\<distro>\` as the worker user. The rules:

- **Only under the slot's own folder.** An absolute path, a drive, a UNC path, `..`, or a name Windows does not allow
  is refused (exit 7).
- **No link or junction is followed or copied.** Each folder from the slot folder down to the path is checked, and a
  link anywhere inside a folder being copied refuses the whole copy (exit 7).
- **No secrets without `--allow-config`.** The slot's config and key files, ticket 40's protected list, are refused
  (exit 7, naming them): `InnovatorServerConfig.xml`, `*.pfx`, `*.cer`, `key-*.xml`, `vault.config`, in any folder
  and any case, and every file the flavor's edit list writes a secret into (`SelfServiceReportConfig.xml`, which holds
  a SQL login's password). A folder that holds one is refused whole; narrow the path, or pass `--allow-config`, which
  copies them and says on stderr that they hold the slot's secrets. Those secrets die with the lease (the reset renders
  new ones), but keep them out of commits and logs.
- **Nothing is replaced.** If `<dir>/<name>` exists, the command is refused (exit 7) before anything is copied.

A path that is not in the slot exits 1. A lease that is not held (returned, or unknown) exits 4.

## Data: `extract db`

```
arashouse extract db --lease <id> --to <file.bak>
```

Writes a `COPY_ONLY` backup of the leased slot's database (`arashouse_<key>_<NN>`) to `<file.bak>`. `COPY_ONLY`
leaves the database's own backup sequence alone. The file is a normal SQL Server backup: `RESTORE DATABASE` it
anywhere, or give it to `get --restore` (ticket 39, `docs/restore.md`) on a later lease of the same flavor.

1. The CLI makes `<root>\staging\<lease_id>\` (the worker may change `staging\`, ticket 21) and names a new file in it,
   `extract-db-<8 hex>.bak`.
2. The broker's `backupDatabase` verb (below) writes the backup there.
3. The CLI copies it to `<file.bak>.part-<8 hex>` beside the destination, checks the size, renames it to
   `<file.bak>`, then deletes the staged copy and the lease's staging folder when it is empty. On a failure the staged
   copy and the partial file are deleted as well.

`<file.bak>` must not exist (exit 7) and its folder must (exit 2). A broker that is not reachable exits 6.

### The broker's `backupDatabase` verb

`args.path` is the staged file. The broker refuses (`Refused`, exit 7):

- a slot whose stamp names no lease: **only a leased slot's database is backed up**, never a free, dirty or
  quarantined one, and never any database the slot's name does not derive (`OLM_Local`, `olm`, prod and every other
  name are refused by the slot-record guards before anything is read, in the CLI's process and again in the broker);
- a path that is not a `.bak` inside `staging\<the lease the stamp names>\`, or that has a junction in it. The path is
  checked again just before the copy, since the worker may change `staging\` while the backup runs;
- a file that exists there: the copy never replaces one.

The backup itself is `BACKUP DATABASE [arashouse_<key>_<NN>] TO DISK = '<root>\sqldata\arashouse_<key>_<NN>-extract.bak'
WITH COPY_ONLY, INIT, FORMAT, CHECKSUM`, run by the broker as the database's owner (no server role, no procedure). It
goes to `sqldata\` first because SQL Server writes a backup as its own service account, which may write `sqldata\`
only (ticket 21); the broker then copies it into the lease's staging folder (the copy takes that folder's inherited
access, so the worker can read and delete it) and deletes the scratch copy, whatever happened. The `slot-steps.ps1`
step `backup-database` takes no path from the request: it derives the database and the scratch file from the flavor
and slot number.

## The reminder at return

`arashouse return` prints one line to stderr when it gives a lease back:

```
Returning slot 23-02. Its state will be discarded; anything you want to keep must already be out.
```

No prompt and no delay; `--quiet` leaves it out. A repeated `return` (`already returned`) prints nothing. The worker
guide (ticket 48) says the same.

## On the host (2026-10-28)

`test/host/extract-cycle.ts`, run by `test/host/extract-12sp9.test.ts` (`ARASHOUSE_TEST_EXTRACT=1`, the variables are in
its header) from WSL as the worker, non-elevated, against the broker of this ticket (installed through firstmate's
elevated gate with `setup-host.ps1 -Apply -UpdateBroker`, exit 0). It passed in 314 s on lease `12sp9-01`:

| step | result |
|---|---|
| the lease, changed as a leaseholder can | a Part through the API, a `LIBSJS-SCRATCH` package imported with libs-js, a file written into `Innovator\Client` by a server Method of the leaseholder's (the dirt of `docs/e2e-12sp9.md`) |
| `extract code` of the changed Client file | copied in 0.1 s; the same bytes |
| `extract code InnovatorServerConfig.xml`, `extract code ../02` | refused, exit 7 |
| `extract db` | 86.1 MB `COPY_ONLY` backup in 3.3 s (the broker's backup 1.1 s, with the copy 1.8 s); an MTF `TAPE` file holding the lease's Part number; `staging\<lease_id>\` gone after |
| `run --lease ... aras-pkg export --package` of the scratch package | exit 0 in 25.6 s; `imports.mf` and the Variable written |
| `status --json` | `extracted` false before, true after |
| the broker, sent past `BrokerHost`'s guards | refused the backup of `12sp9-02` (free: "not leased"), a path in another lease's staging folder, a path under `golden\`, and the slot records `OLM_Local`, `olm` and `prod`; `BrokerHost` refused those three before sending |
| `return` | the reminder line on stderr, not stdout; the slot free again 62.4 s later |
| after the reset | the Client file gone; the health check passed (9 checks); the next lease of `12sp9-01` had neither the Part nor the package; `return --quiet` printed no reminder |
| the extracted copies | the code file, the backup and the export the same by SHA-256 after the return and the reset |
| the host as found | the deny-list fingerprints unchanged; no lease password in any command's output or the record |

Three earlier runs failed, none in the tool: twice WSL's interop to Windows timed out (`UtilAcceptVsock ... accept4
failed 110`) while other lanes loaded the host, before a lease was taken; once the scratch Variable's name was longer
than the column's 32 characters, and the proof returned its lease.
