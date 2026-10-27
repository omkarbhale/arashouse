# spike

PowerShell scripts for the captain-assisted slice 0 sittings on the Windows host (tickets 05 to 08). Workers cannot elevate, so the
captain runs these in an elevated PowerShell; a worker reads the results afterwards. Nothing here is run by the test suite except the
dry runs and guard checks in `test/spike.test.ts`.

Windows PowerShell 5.1 (the host has 5.1.26100.9444). Every file is plain ASCII.

## Conventions

- **Dry run by default.** Without `-Apply` a script prints only `would do:` lines (plus one `dry run:` banner) and changes nothing.
  With `-Apply` every change is printed as a `do:` line first. `-Apply` on a script that changes the host needs an elevated shell.
- **Throw-away names only.** Folder `C:\aras_installations\spike\` (writes), `staging\` (installer media), alias `ah-spike-*`, database
  `arashouse_spike_*`, service `ArasHouseAgent_spike_*`, SQL and local logins `arashouse_spike_*`. Before each step the script asserts
  the target matches the prefix and is not on the deny-list (`lib/SpikeCommon.ps1`: the three install roots under
  `C:\Program Files (x86)\Aras*`, databases `12sp9`, `OLM_Local`, `InnovatorSolutions`, `RabbitDemo1`, `InnovatorSolutions28`, aliases
  `12sp9`, `InnovatorServer*`, services `ArasInnovatorAgent_*`, and any name containing `olm` or `prod`). Names are checked before the
  first line is printed, so a deny-listed name fails even in a dry run. No script opens a connection to any database but `master` and
  `arashouse_spike_*`. The only touch of an existing install is the read-only hash of its `InnovatorServerConfig.xml` in `00-preflight`.
- **Secrets.** The `sa` password, the licence key and the Aras login password are read with `Read-Host -AsSecureString` (or, for the
  Aras login, from `$env:ARASHOUSE_SPIKE_ARAS_PASSWORD` if you exported it in the session). They stay `SecureString`s, become plain
  text only inside the call that needs them, are never echoed and never written to a file. SQL connections use `SqlCredential`; the MSI
  install runs in-process through the Windows Installer COM API, so no secret is on a process command line (`-Engine Msiexec`
  refuses any install that would put one there). MSI logs are written without verbose property dumps, with the secret-looking property
  names in `MsiHiddenProperties`, and deleted if a scan finds a handled secret. Every script ends by scanning `spike\out\` for the secrets it
  handled and fails loudly (deleting the leaking file) if one is found. Generated per-slot SQL passwords exist only in the clone's own config.
- **Results.** Each script writes `C:\aras_installations\spike\out\NN-<name>.json`: versions, timings, booleans, sizes, property
  names, file lists. A worker reads them at `/mnt/c/aras_installations/spike/out/` (`scripts/spike-sync.sh --results` lists them) and
  quotes them in the spike ticket's `## Answer`.
- **Names derive from `-Flavor` (default `12sp9`) and a suffix:** baseline `a` (alias `ah-spike-12sp9-a`, database
  `arashouse_spike_12sp9_a`, tree `golden-build\12sp9`), clone `b` (`slot-12sp9-b`, `vaults\12sp9-b`, service
  `ArasHouseAgent_spike_12sp9_b`), scratch `m` (measure) and `o` (owner test).

## Delivery

From WSL, in a checkout of this repo: `scripts/spike-sync.sh` copies `spike/` to `C:\aras_installations\spike\` (it never touches
`out\` or the working folders), and `scripts/spike-sync.sh --media 12sp9` copies the CD image zip from the main checkout's
`media/12sp9/` into `staging\12sp9\` (`10-baseline-install.ps1` unpacks it with `tar.exe`). Until the first elevated step has created the Windows
folders, `spike-sync.sh` prints the command to run `01-init-folders.ps1` straight from the repo.

Run scripts with `powershell -ExecutionPolicy Bypass -File C:\aras_installations\spike\<script>.ps1 [-Apply]`. First do a dry run of each.

## Sitting order

| # | Script | Elevated | Prompts | What it settles |
|---|---|---|---|---|
| 1 | `01-init-folders.ps1 -Apply` | yes | none | creates `spike\`, `spike\out\`, `staging\`; modify for the worker on `spike\` and `staging\` only |
| 2 | `scripts/spike-sync.sh [--media <flavor>]` | no | none | scripts and installer media onto the host |
| 3 | `00-preflight.ps1 -Apply` | no | none | read-only inventory; first run also writes the deny-list baseline (16-hex prefixes of the install roots' config hashes) |
| 3b | `09-new-product-code.ps1 -Apply` | no | none | a copy of the MSI in `staging\<flavor>\instance\` with new ProductCode, ProductID, UpgradeCode and package code; without it the MSI reconfigures the captain's install of the same release |
| 4 | `10-baseline-install.ps1 -Apply` | yes | `sa`, Aras root password; licence only with `-WithLicence` | ticket 05 steps 2 to 4: unattended install, install directory outside Program Files, what the MSI created, version check |
| 4b | `10-baseline-install.ps1 -Suffix c -DatabaseMode None -Apply` | yes | Aras root password | ticket 05 step 3: does `INSTALL_DATABASE=0` work (then restore the `.bak` by hand or with 20) |
| 5 | `20-clone-slot.ps1 -Apply` | yes | `sa`, Aras root password | ticket 05 step 5: second instance side by side |
| 6 | `30-licence-reuse.ps1 -Apply [-LicenceSourceConfig '<cfg>[\|<cfg>...]']` | yes | Aras root password; licence key and activation key unless read from installed configs | ticket 05 step 6: one key for both slots, key needed for login; several sources are tried in turn (ticket 07: a 12.x key against 14.0.9) |
| 7 | `40-measure.ps1 -Apply [-TestDefenderExclusion]` | yes | `sa` (none with `-SqlAuth Windows`), Aras root password | ticket 06 checks 2, 3(a), 6, 7 and sizes |
| 8 | `50-quiesce.ps1 -Apply` | yes | Aras root password | ticket 06 checks 1 and 5 (a stand-in service of the slot's name is used when the clone has no agent) |
| 9 | `60-sql-restore-owner.ps1 -Apply` | yes | `sa` (none with `-SqlAuth Windows`), Aras root password | ticket 06 checks 3(b), 4: owner restore (also over an open connection), stored-procedure fallback, fix-ups, per-lease password routes |
| 10 | `90-teardown.ps1 -Apply` | yes | `sa` | removes everything with a spike prefix |
| 11 | `00-preflight.ps1 -Apply` | no | none | `denyListUnchangedSinceBaseline` must be `true` |

Steps 3b to 6 are ticket 05, steps 7 to 9 are ticket 06 and may share its sitting. Ticket 07 repeats steps 3 to 6, 10 and 11 with
`-Flavor 23` (4b after 6, with a fresh 3b in between: the first install's product code is then registered); ticket 08 with `-Flavor 35`.

## The ticket 06 sitting

Ticket 05 tore everything down, so ticket 06 rebuilds the baseline and the clone first, then measures. `sa` was refused in ticket 05, so
every SQL step uses the elevated user's Windows login (`-SqlAuth Windows`); nothing prompts for `sa`. The Aras login password comes from
`spike\handoff\aras.dpapi` (left by ticket 05) or a hidden prompt. Workers never raise UAC: the elevated steps run in three parts, each
a single PowerShell file with the SHA-256 of every spike script it calls pinned inside (it refuses to run if one differs):

| Part | Who | Runs | Changes |
|---|---|---|---|
| 1 | firstmate's elevated gate | `00-preflight -Apply`, `10-baseline-install -SqlAuth Windows -Apply`, `20-clone-slot -SqlAuth Windows -Apply` | baseline `a` and clone `b`: trees, IIS apps and pools, databases and logins, vault folders (spike names only) |
| 2 | the captain (a licence step) | `30-licence-reuse -LicenceSourceConfig 'C:\Program Files (x86)\Aras12\Innovator\InnovatorServerConfig.xml' -Apply` | the `<License>` of both spike configs; the captain's config is only read |
| 3 | firstmate's elevated gate | `40-measure -SqlAuth Windows -Apply [-TestDefenderExclusion]`, `50-quiesce -Apply`, `60-sql-restore-owner -SqlAuth Windows -Apply`, then always `90-teardown -SqlAuth Windows -Apply` and `00-preflight -Apply` | scratch copies, databases, logins, a local user and a stand-in service (all spike names), a temporary Defender exclusion; then removes everything with a spike prefix |

- `-TestDefenderExclusion` adds a Defender exclusion for `C:\aras_installations\spike` for the second set of mirror timings and removes
  it afterwards (90 removes a leftover).
- A step that fails part way still writes the facts it gathered, with `failedWith`, to `out\`. If part 1 fails, run 90 and 00.

## Things the first sitting is expected to learn (the scripts record them; they do not guess)

- The MSI's real property values: `00-preflight.ps1 -Apply` writes the Property table's names and non-secret default values for each
  staged MSI into `out\00-preflight.json` (`stagedInstallers`). Read it before the sitting. `10-baseline-install` sets only properties
  that exist in the MSI, from this list: `WEBALIAS`, `INSTALL_DATABASE`, `INSTALL_AGENT_SERVICE=0`, `CHANGEGUID=1`, `IS_SQLSERVER_SERVER`,
  `IS_SQLSERVER_DATABASE`, `IS_SQLSERVER_USERNAME`, and the install-directory property (`-InstallDirProperty`, default `INSTALLDIR`). Its result lists
  `propertiesSet` and `propertiesMissingFromMsi`; if the install fails, correct values go in `-MsiProperty @{ NAME = 'value' }` (non-secret
  properties only).
- Whether the install directory can be set unattended (`installedUnderRequestedDir`, `programFilesAras.unchanged`).
- The agent service is not installed by the MSI by default (so no `ArasInnovatorAgent_*` service can appear next to the captain's); `20` creates
  `ArasHouseAgent_spike_*` from the clone's `AgentService` folder. Any service the MSI creates anyway is listed in `newServices`.
- The attribute names of `<DB-Connection>` and whether the shipped config stores passwords in a form the clone's edit can replace
  (`dbConnectionAttributeNames`). `uid`/`pwd` and `regular_uid`/`regular_pwd` are assumed; the result says if they are not found.
- The shipped backup's database user names (`restoredDatabaseUsers`) and the `innovator` / `innovator_regular` remap.
- The `root` OOTB password for the login checks is typed at a hidden prompt (the first prompt of a script that logs in); export
  `ARASHOUSE_SPIKE_ARAS_PASSWORD` in the elevated session to type it once.

## Checks that stay dry-run-safe

`lib/Test-SpikeName.ps1 -Kind Database -Name OLM_Local` prints `DENIED|...` and exits 2; `-CaseFile` takes `Kind|Name` lines (kinds
`Database`, `Login`, `Alias`, `Pool`, `Service`, `Folder`, `ReadFolder`). `test/spike.test.ts` runs the parse check, a dry run of every
script and the deny-list cases under Windows PowerShell 5.1 (`powershell.exe` from WSL; override with `SPIKE_POWERSHELL`), and skips them when it is
absent, since the scripts target `C:` paths a Linux `pwsh` does not have.
