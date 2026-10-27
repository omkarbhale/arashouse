# Baselines: `arashouse baseline build` and `baseline verify`

Tickets 24 (the builder, `12sp9`) and 26 (`23`, and the engine check). A flavor's **golden** (`C:\aras_installations\golden\<key>`) is what every slot of the flavor is made
from and reset to: its code tree, its database backups and the records that describe them. It is built once per
flavor from the captain's installer in `media/<key>/`, into a throw-away instance that is removed again, and it is
immutable: only another build, with `--replace`, changes it. Building is the only operation that needs the installer
and an administrator again.

## Running it

1. From WSL, in the arashouse checkout, after `npm run build`:

   ```
   node dist/cli/index.js baseline build 12sp9          # or `arashouse baseline build 12sp9`
   node dist/cli/index.js baseline build 23 --engine-check <a built import-export-libs-js checkout>
   ```

   It refuses a flavor whose golden already exists (it asks the broker's `baselineVerify`; a broker it cannot ask
   is reported and the script checks again), runs the media check (`docs/media-check.md`) and refuses media that
   fail it or an MSI that lacks a property the install sets, then writes the **bundle** to
   `C:\aras_installations\staging\baseline-<key>\`: `baseline-build.ps1`, `baseline-steps.ps1`, `plan.json`,
   `package.json`, `app\` (a copy of `dist\`) and `media\` (the MSI and the two shipped backups, unpacked from the CD
   image zip with their CRC-32 checked). With `--engine-check <dir>` it also copies the libs-js CLI into `engine\` (below). It
   prints the commands below.
2. The captain, in an **elevated** Windows PowerShell (or firstmate's elevated gate):

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\aras_installations\staging\baseline-12sp9\baseline-build.ps1"          # checks the bundle, changes nothing
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\aras_installations\staging\baseline-12sp9\baseline-build.ps1" -Apply   # builds the golden
   ```

3. From WSL: `arashouse baseline verify 12sp9` (exit 0 when the golden matches its manifest; `--full` hashes every
   file; `--json` prints the diff).

`baseline-build.ps1` switches: `-Apply` (without it the script only checks the bundle), `-Replace` (rebuild over an
existing golden), `-Cleanup` (remove what a failed build left of the throw-away instance, nothing else),
`-AskLicence` / `-LicenceFile <f>` and `-AskAdminPassword` / `-AdminPasswordFile <f>` (for the login check, below).
Exit codes: 0 ok; 1 a step failed (the throw-away instance is removed); 2 refused arguments; 3 the bundle does not
match its pins; 4 not elevated; 5 no usable `node.exe`.

## Why an elevated script, not a broker verb

The plan made the build a broker verb. It is not one: the broker's SQL login (`NT SERVICE\ArasHouseBroker`, ticket
22) is in no server role and its procedures admit only slot names, so it cannot create `arashouse_build_<key>`
(`docs/setup-sql.md`: "created in the captain's own session"). The build is also a 5 to 15 minute job that runs
an MSI, which a request on the pipe is not made for. So the script runs in the captain's elevated session, as
`setup` and `setup-sql` do, and connects to SQL Server with the captain's Windows login (no `sa`).
`HostDriver.baselineBuild` on the real host (`BrokerHost`) refuses with the command to run; `FakeHost` keeps it for
the offline lease tests.

The script is a thin wrapper: it checks the SHA-256 of every bundle file it trusts (pinned in its text when the CLI
wrote it; it also refuses an unpinned file under `app\`), elevation and Node (20 or newer), reads the optional
secrets, and starts `app\broker\baseline-main.js` under Node. The steps are TypeScript
(`src/broker/baseline-build.ts`), so the order, the cleanup and the golden records are tested offline; the operations
Node cannot do itself (Windows Installer, IIS, SQL Server, robocopy, icacls) are one `baseline-steps.ps1 -Step <name>`
process each (`src/broker/baseline-steps.ts`), with a JSON request on stdin and one result line on stdout. That
script derives every name and path from the flavor alone, by the rules of `src/core/names.ts`, and takes nothing
else from the request but the restore step's two generated passwords.

## The steps

| step | what it does |
|---|---|
| `preflight` | prerequisites (`setup-host.json`'s missing list) present, free disk at least `min_free_disk_gb`, the media in the bundle and the MSI's SHA-256 the CLI recorded, no golden unless `-Replace`, nothing of an earlier throw-away instance left |
| `snapshot` | the deny-list fingerprints, before (below) |
| `msi-copy` | a copy of the MSI with a new ProductCode, ProductID, UpgradeCode and package code in `golden-build\<key>.msi\` (what Aras's `ChangeGUID` does to the MSI, without its registry writes); the shipped MSI shares the ProductCode of the captain's installs and would reconfigure them |
| `msi-cost` | costs the copy without installing it and refuses if any folder a component writes resolves outside `golden-build\<key>` and `golden-build\<key>.vault` |
| `install` | the unattended install below, through the Windows Installer COM API; the log (no property dump) is read for failed actions and error numbers and deleted |
| `pools` | each application of `/ah-build-<key>` moves from the MSI's machine-wide pools (which the captain's installs share) to its own `ah-build-<key>-<role>`; then `IIS_IUSRS` (every pool identity is a member) gets modify on every folder and file of the install directory and the vault root, and IUSR read. `golden-build\` has a protected ACL that names no IIS account, and the MSI turns inheritance off on `OAuthServer\App_Data` and grants `IIS_IUSRS` that folder only, not the SQLite file in it: without this the first builds answered HTTP 500 and the OAuth server died with "unable to open database file". The grants stay on the throw-away instance: robocopy copies no ACL into golden, so a slot (ticket 25) needs the same grants |
| `database` | creates `arashouse_build_<key>_dbo` and `_reg` (24 random letters and digits each), restores the shipped `CoreAndSolutions*.bak` as `arashouse_build_<key>` with its files in `sqldata\`, and maps its users `innovator` and `innovator_regular` to them (spike record, section 4; the CD's SQL scripts are not run) |
| `configure` | writes the two passwords, and the licence key when given, into the build's `InnovatorServerConfig.xml` with the edit engine |
| `verify` | (a 500 or 503 is asked again for up to a minute, a fresh application's first start) `Server/DBList.aspx` (where the MSI installs it) lists exactly the build database; `OAuthServer/.well-known/openid-configuration` answers 200; `Aras.Server.Core.dll` is the registry's build; with the licence key and the admin password, an OAuth password grant as `root`; after the login, in a bundle written with `--engine-check`, the engine check (below) |
| `stop` | stops the build's pools and waits for their worker processes to exit, then for every process started from the build folder (from 14.0 the applications run out of process: `Aras.Server.exe`, `Aras.Client.exe`, spike 07), ending any still there after 30 s; `remove` does the same after it removes the pools |
| `blank-secrets` | blanks `dbo_pwd`, `regular_pwd` and `lic_key` in the build's config, before anything is copied |
| `capture-tree` | `robocopy /E /XJ /COPY:DAT /DCOPY:T` of the install directory (without a `DB\` folder) to the new golden's `tree\`, then checks that no secret of this build is in its config files |
| `capture-db` | the shipped `Core*.bak` and `CoreAndSolutions*.bak`, and a `COPY_ONLY, CHECKSUM` backup of the build database as `ootb.bak` (SQL Server writes it to `sqldata\`, since it may not write `golden\`; the build copies it in) |
| `metadata` | `edits.json` (the flavor's edit list, `docs/edits.md`), `iis.json` (the applications: sub-path, physical path, role, pool settings), `service.json` (no agent: `INSTALL_AGENT_SERVICE=0`) |
| `manifest` | `manifest.json` (`docs/manifest.md`) of `tree\`, and `flavor.json`: release, server build, MSI SHA-256 and version, build time and seconds, host prerequisites, tree counts, each backup's size and SHA-256, the manifest hash |
| `promote` | moves the new golden (assembled in `golden-build\<key>.golden`) into `golden\<key>`; with `-Replace` the old one is set aside in `golden-build\<key>.old` first and removed after |
| `remove` | removes the throw-away instance: its IIS applications and pools, its product registration (`msiexec /x`, after the applications, as spike 90 did), the database, the two logins and their `master` users, any service whose binary is in the build folder, ASP.NET's temporary files of the alias, and the folders `golden-build\<key>*` |
| `deny-list` | the fingerprints again; any difference fails the build |
| `seal` | `golden\<key>`: SYSTEM and Administrators full, the broker and SQL Server read, and the broker **denied** every change (it is an Administrator, so a plain read grant would not hold it), applied again to every file under it |

A failure from `msi-copy` on runs nothing after it, removes the throw-away instance and the half-assembled golden,
moves a replaced golden back, and re-checks the deny-list; the report names whatever could not be removed. Nothing
is written into `golden\<key>` but by the `promote` move, so a failed build leaves the old golden, or none, as it was.
`-Cleanup` runs only the removal.

**The unattended install** (spike record, section 1): `INSTALLDIR=<root>\golden-build\<key>` and
`VAULT_ROOT=<root>\golden-build\<key>.vault` always (omitted, the MSI installs into Program Files and `C:\Aras\Vault`);
`WEBALIAS=ah-build-<key>`; `INSTALL_DATABASE=0` (no database, no SQL rights in the installer; the build restores the
shipped backup); `INSTALL_AGENT_SERVICE=0`; `IS_SQLSERVER_SERVER=(local)`, `IS_SQLSERVER_DATABASE=arashouse_build_<key>`,
`IS_SQLSERVER_AUTHENTICATION=0`; `SQL_SERVER_LOGIN_NAME` and `_REGULAR_NAME` the build's logins (their defaults are the
machine-wide `innovator` logins); `REBOOT=ReallySuppress`, `MSIRESTARTMANAGERCONTROL=Disable`;
`MsiHiddenProperties=LICENSEKEY;IS_SQLSERVER_PASSWORD;SQL_SERVER_LOGIN_PASSWORD;SQL_SERVER_LOGIN_REGULAR_PASSWORD;OAUTH_CERTIFICATES_PASSWORD`.
No password and no licence key is passed to the MSI. Each public property must be a row of the MSI's Property table
(`media check`'s names, and again inside the step), or the install is refused before it starts.

## The engine check

The import-export-libs-js engine of a flavor (`12.0`, `14.0.7`, `14.35`; the registry's `libsJsEngine`) must accept the
server: its login gate and version probe. `arashouse baseline build <key> --engine-check <dir>` takes a built libs-js
checkout (`npm ci` runs its build) and copies into the bundle's `engine\` its `package.json`, the `.js` files of `dist\`
and every file of each runtime dependency (`@xmldom/xmldom`, `xpath`; a dependency with dependencies of its own is
refused), each pinned by SHA-256 in `baseline-build.ps1` like `app\`; `plan.json` says `"engineCheck": true`. The check
needs the login's secrets: after the `root` login passes, `verify` runs, under the build's Windows `node.exe` (the
server's OAuth discovery names `http://localhost/...`, which only the host reaches, spike 07):

```
node.exe engine\dist\cli.js export golden-build\<key>.engine\pkg ItemType:<the shipped Part's id> --engine <libsJsEngine>
  --url http://localhost/ah-build-<key> --database arashouse_build_<key> --user root --password-stdin --json
```

with the admin password on its standard input (no argument, no environment). It passes when the CLI exits 0 and its
summary says `success`, the flavor's engine, the registry's server build and one item; `golden-build\<key>.engine` is
removed after it either way. The report says `engineChecked: true`. Without the login, or in a bundle without
`--engine-check`, the check is skipped and the report says `engineChecked: false`.

## What golden holds

```
golden\<key>\
  tree\             the code tree slots are mirrored from (ticket 30)
  db\Core*.bak, db\CoreAndSolutions*.bak   the shipped backups, as on the CD
  db\ootb.bak       the build database after the build's checks, COPY_ONLY
  manifest.json     every file of tree\ outside the runtime directories, hashed (docs/manifest.md)
  edits.json        the flavor's config edit list (docs/edits.md)
  iis.json          the build alias's applications and pool settings (ticket 25's slot templates)
  service.json      the agent service's definition, or that there is none
  flavor.json       release, build, MSI SHA-256, built-at, prerequisites, counts, backups, manifest hash
```

The golden's configs still name the build's alias, database and folder (`ah-build-<key>`, `arashouse_build_<key>`,
`golden-build\<key>`); the edit list replaces them in a slot (`build.*` variables). They hold no licence key and no
password: the build blanks them before the copy and checks the copy for its own secrets. OAuth certificates are
copied with the tree, so every slot of a flavor shares them (design 5.2).

## The deny-list self-check

The ticket asked for ticket 04's before-and-after hashes as a self-check, names only. The build fingerprints, before
it changes anything and again after it has removed the throw-away instance:

- each of the captain's install roots on the deny-list: the SHA-256 of its `InnovatorServerConfig.xml` (or that it
  has none or is absent);
- every IIS application and every pool whose name does not start with `ah-`: the pool and physical path of each
  application, and each pool's settings and member applications (the MSI's machine-wide pools are among them);
- every service whose name starts `ArasInnovatorAgent_`: its binary, start mode and account;
- every product registered as `Aras*` whose install location is not under the root: name, version, location.

Each fingerprint is a SHA-256 of those properties; the report and the error name the objects only. Databases are
not listed: the tool does not enumerate databases it does not own (ticket 22), and the build creates and drops only
`arashouse_build_<key>`. IIS is read with administrator rights only; the step refuses to run on an empty read
rather than compare nothing.

## Secrets

- The build's two SQL login passwords are generated per build, reach SQL Server only on the restore step's stdin
  and the build's own config, and are blanked before the copy; the logins are dropped with the instance.
- The **licence** (line `12` for `12sp9`, `14` for `23` and `35`) is needed to log in, not to install (spike
  record, section 2), and the key alone is not enough: with `lic_key` set and the rest of the `<License>` element
  left as the MSI wrote it, the server answered "License Key is invalid". The login needs the whole element, `lic_key`,
  `act_key`, `lic_type` and `company`, as spike 30 copied it. The build takes it only for the login check, from a
  hidden prompt (`-AskLicence`, the key alone) or a file of `ConvertFrom-SecureString` output that only the captain's
  Windows user can read (`-LicenceFile`: the key, or the JSON `{ "lic_key", "act_key", "lic_type", "company" }`),
  hands it to Node in that process's environment only (`ARASHOUSE_BUILD_LICENCE`, read once and removed), writes it
  into the build's config for the check, and before the copy blanks `lic_key` and `act_key` and puts back the
  `lic_type` and `company` the MSI wrote. It stores it nowhere: storing it machine-scope for slots is
  the secret store's job when ticket 25 renders slot configs.
- The **admin password** of the shipped backup's `root` login comes the same way (`-AskAdminPassword`,
  `-AdminPasswordFile`; for example the spike's `C:\aras_installations\spike\handoff\aras.dpapi`) and goes only into
  the OAuth request, as its MD5, as the Aras clients send it.
- The MSI log is deleted whatever happens. Every step line and the report pass through `redact`.

Without both secrets the login check is skipped and the report says `loginChecked: false`; the other checks still
run. A licence key exists only in the captain's hands, so a run through firstmate's non-interactive gate builds the
golden without the login check; the login is then first proven on a slot (ticket 35), or in a captain sitting with
`-Apply -AskLicence -AdminPasswordFile <f>`.

## `--replace`

`arashouse baseline build <key> --replace` marks every `free`, `resetting` or `provisioning` slot of the flavor
`dirty` before it writes the bundle, so none is handed out against the old golden; a leased slot goes dirty when it
is returned, and a quarantined or disabled one is reset by `repair` or `enable`. The captain then runs the script
with `-Apply -Replace`. Without `-Replace` the script refuses an existing golden. A slot reset from the old golden
in between is not handed out after the promote: `get` compares its golden hash with the current one, and `promote`
holds `golden-build\<key>.promoting` while it moves folders, during which a reset gives its slot back dirty
(`docs/reset.md`).

## Measured: the first `12sp9` golden (2026-10-27)

Built on the laptop through firstmate's elevated gate (the captain's Windows login, no prompt), from
`media/12sp9/12.0 SP9 CD Image.zip` (MSI SHA-256 `a5bd92d01ec6...`, 355.1 MB). The fourth run built the first golden
without the login check; two `-Replace` rebuilds then proved the login, with the licence read read-only from the
captain's Aras12 config by a one-off gate wrapper (captain-approved, outside the repo; the tool itself never reads an
existing install). Every failed run's cleanup left nothing behind (`leftovers: []`), and the failed rebuild moved the
old golden back, which proved both failure paths on the host:

| run | failed at | cause | fix |
|---|---|---|---|
| 1 | `verify`: `DBList.aspx` and OAuth discovery HTTP 500 | `golden-build\`'s protected ACL names no IIS account, so the pools could not read the tree | grant the pools access |
| 2 | `pools` | the generated script lost the backslash of `IIS AppPool\<pool>` (a template literal ate it) | a static test |
| 3 | `verify`: `DBList.aspx` 404, OAuth 502.5 | `DBList.aspx` is in `Innovator\Server` (the `/Server` application, from the MSI's File table); the OAuth server died with SQLite "unable to open database file" (Application event log), since the MSI turns inheritance off on `OAuthServer\App_Data` and grants `IIS_IUSRS` the folder only | `IIS_IUSRS` modify on every file of the instance (`icacls /T`); `/Server/DBList.aspx` |
| 4 | none (login skipped) | | |
| 5 (`-Replace`) | `verify`: login "License Key is invalid" | only `lic_key` was set; the rest of `<License>` stayed as the MSI wrote it | carry the whole element (`lic_key`, `act_key`, `lic_type`, `company`) |
| 6 (`-Replace`) | none: **logged in as `root`** | | this is the golden in place |

Run 4 (run 6 within a few seconds of it everywhere), step by step (seconds): preflight 2.4, snapshot 1.5 (35 objects fingerprinted), msi-copy 4.9, msi-cost 10.7,
**install 133.1** (MSI exit 0), pools 58.2 (mostly the `icacls /T` over the tree), database 1.6, configure 0,
verify 14.0 (cold start included), stop 6.2, blank-secrets 0, capture-tree 18.7, capture-db 0.6, metadata 0,
**manifest 294.7** (hashing 557 MB), promote 0, **remove 247.2** (mostly `msiexec /x`), deny-list 1.3 (all 35
unchanged), seal 57.9 (re-applying the ACL to every file). **Total 853 s (14.2 minutes)**; run 6, with the login and the
replace, 842 s.

| | |
|---|---|
| Server build | `12.0.0.24090` (`Aras.Server.Core.dll`), as the registry says |
| Tree | 23,763 files, 557.5 MB copied; **23,760 files, 557.4 MB in the manifest** (3 runtime files left out) |
| Manifest hash | `d2c0bb72570ad85299f24a2dcb2f9c5eb540a989bf544fa9bd4c22085328c670` (run 6; run 4's was `00596b9b4a70...`: same files, new install times) |
| IIS | 7 applications: `/ah-build-12sp9` and `/Client`, `/Server`, `/NotificationServer`, `/OAuthServer`, `/SelfServiceReporting`, `/Vault` |
| Databases | `Core120.bak` 12.2 MB and `CoreAndSolutions120.bak` 14.7 MB (shipped); `ootb.bak` 84.1 MB (the restored database after the checks and the login, `COPY_ONLY`, no compression; 77.1 MB without the login) |
| Agent | none (`service.json`: `installed: false`) |
| Login check | passed: an OAuth password grant as `root` with the shipped password (run 6) |

From WSL as the worker, through the broker (built from this ticket): `arashouse baseline verify 12sp9` passed in
1.7 s (golden level, 23,760 files), `--full` in 23.8 s the first time and 6.5 s warm (every SHA-256), and
`arashouse doctor` reports `ok baseline 12sp9`.

## Measured: the `35` golden (2026-10-27, ticket 27)

Built on the laptop through firstmate's elevated gate in one run, with no change to the builder, from
`media/35/Release 35 CD Image.zip` (MSI SHA-256 `88505cad727c...`, 558.4 MB, `ProductVersion` 14.35.0). The login check
ran: the whole `<License>` element of the 14.x line came, as for `12sp9`'s run 6, from a one-off gate wrapper
(captain-approved, outside the repo) that read it read-only from the captain's Aras28 config, the 14.0 SP18 key that
spike 08 showed serves 14.35. No patch is part of the baseline (spike 08: `Aras Innovator 35 Patch.zip` upgrades an
older 14.x to the build the MSI already installs).

Step by step (seconds): preflight 7.3, snapshot 4.7 (35 objects fingerprinted), msi-copy 4.4, msi-cost 18.3,
**install 175.6** (MSI exit 0), pools 57.9, database 1.5, configure 0, verify 43.4 (cold start included), stop 9.8,
blank-secrets 0, capture-tree 22.5, capture-db 1.3, metadata 0, **manifest 236.9** (hashing 1.1 GB), promote 0.1,
**remove 276.8**, deny-list 1.3 (all 35 unchanged), seal 56.8. **Total 919 s (15.3 minutes)**; `leftovers: []`.

| | |
|---|---|
| Server build | `14.35.0.43890` (`Aras.Server.Core.dll`), as the registry says |
| Tree | 23,539 files, 1,106.8 MB copied; **23,536 files, 1,106.7 MB in the manifest** (3 runtime files left out): twice `12sp9`'s size with about as many files |
| Manifest hash | `54e65725cf594ee4b42b8af9ec79ef95440282f6d95aa78ada275fa429364598` |
| IIS | 5 applications (`/ah-build-35` and `/Client`, `/Server`, `/OAuthServer`, `/Vault`; no `/SelfServiceReporting`, spike 08), each on its own pool |
| Databases | `Core140.bak` 11.8 MB and `CoreAndSolutions140.bak` 14.2 MB (shipped; Release 35's own, not Release 23's files); `ootb.bak` 117.1 MB (after the checks and the login, `COPY_ONLY`, no compression) |
| Agent | none (`INSTALL_AGENT_SERVICE=0`) |
| Login check | passed: an OAuth password grant as `root` with the shipped password |
| Engine check | not run against the build (the builder removes its instance in the same run, and no `35` slot exists before ticket 25). Spike 08 ran `aras-pkg export --engine 14.35` of one item against two instances of this same MSI and server build: the 14.35 engine's login gate and version probe accepted `14.35.0.43890` and the item was written (`docs/spike-08-release-35.md`, question 5). Ticket 52 proves it again on a lease |

From WSL as the worker, through the broker: `arashouse baseline verify 35` passed in 1.9 s (golden level, 23,536
files), `--full` in 28.0 s the first time and 8.0 s warm, and `arashouse doctor` reports `ok baseline 35`.

## For later tickets

- **Slots (ticket 25)** are mirrored from golden by robocopy, which copies no ACL, into `slots\`, whose ACL names no
  IIS account either: a slot needs the same grant as the build (`IIS_IUSRS`, or its own pool identities, modify on
  its tree and vault, including the files of `OAuthServer\App_Data`), or its OAuth server cannot open its SQLite file.
- **`DBList.aspx` lives at `/<alias>/Server/DBList.aspx`** in `12sp9` and `35` (the MSI's File table; `/<alias>/DBList.aspx`
  answered 404 on the build). The WSL probe (`src/host/probe.ts`, `docs/slot-url.md`, ticket 29) asks
  `/<alias>/DBList.aspx`; ticket 32 (or a fix to 29) should use the `/Server` path, after checking `23`.
- A slot's licence needs the whole `<License>` element, not `lic_key` alone (run 5): ticket 25's edit list adds
  `act_key` (`{{secret:licence_act_key}}`), `lic_type` and `company`, and the secret store keeps the four together.
