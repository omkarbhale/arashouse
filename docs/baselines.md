# Baselines: `arashouse baseline build` and `baseline verify`

Tickets 24 (the builder, `12sp9`), 26 (`23`, and the engine check) and 33b (the agent service). A flavor's **golden** (`C:\aras_installations\golden\<key>`) is what every slot of the flavor is made
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
| `verify` | (a 500 or 503 is asked again for up to a minute, a fresh application's first start) `Server/DBList.aspx` (where the MSI installs it) lists exactly the build database; `OAuthServer/.well-known/openid-configuration` answers 200; `Aras.Server.Core.dll` is the registry's build; the build's agent service (below) exists, runs an executable inside the build folder, is started if it is not running, listens on its port and answers its health request; with the licence key and the admin password, an OAuth password grant as `root`; after the login, in a bundle written with `--engine-check`, the engine check (below) |
| `stop` | stops the build's agent service through the service manager (by its name), then the build's pools, and waits for their worker processes to exit, then for every process started from the build folder (from 14.0 the applications run out of process: `Aras.Server.exe`, `Aras.Client.exe`, spike 07), ending any still there after 30 s; `remove` does the same after it removes the pools |
| `blank-secrets` | blanks `dbo_pwd`, `regular_pwd` and `lic_key` in the build's config, before anything is copied |
| `capture-tree` | `robocopy /E /XJ /COPY:DAT /DCOPY:T` of the install directory (without a `DB\` folder) to the new golden's `tree\`, then checks that no secret of this build is in its config files |
| `capture-db` | the shipped `Core*.bak` and `CoreAndSolutions*.bak`, and a `COPY_ONLY, CHECKSUM` backup of the build database as `ootb.bak` (SQL Server writes it to `sqldata\`, since it may not write `golden\`; the build copies it in), taken after the database is handed to the broker's login (`ALTER AUTHORIZATION`), so the `dbo` inside `ootb.bak` is the broker and a slot restored from it is the broker's inside too (ticket 25, `docs/provision.md`) |
| `metadata` | `edits.json` (the flavor's edit list, `docs/edits.md`), `iis.json` (the applications: sub-path, physical path, role, pool settings), `service.json` (the agent service, below), after checking the agent's executable is in the new golden's tree |
| `manifest` | `manifest.json` (`docs/manifest.md`) of `tree\`, and `flavor.json`: release, server build, MSI SHA-256 and version, build time and seconds, host prerequisites, tree counts, each backup's size and SHA-256, the manifest hash, and `ootbOwner` (the broker's login, above; a golden without it is refused by `provision`) |
| `promote` | moves the new golden (assembled in `golden-build\<key>.golden`) into `golden\<key>`; with `-Replace` the old one is set aside in `golden-build\<key>.old` first and removed after |
| `remove` | removes the throw-away instance: its IIS applications and pools, its product registration (`msiexec /x`, after the applications, as spike 90 did), the database, the two logins and their `master` users, the build's agent service by its name if the uninstall left it (stopped first, and only when its executable is in the build folder), ASP.NET's temporary files of the alias, and the folders `golden-build\<key>*`. Any other service whose executable is in the build folder is reported, never touched |
| `deny-list` | the fingerprints again; any difference fails the build |
| `seal` | `golden\<key>`: SYSTEM and Administrators full, the broker and SQL Server read, and the broker **denied** every change (it is an Administrator, so a plain read grant would not hold it), applied again to every file under it |

A failure from `msi-copy` on runs nothing after it, removes the throw-away instance and the half-assembled golden,
moves a replaced golden back, and re-checks the deny-list; the report names whatever could not be removed. Nothing
is written into `golden\<key>` but by the `promote` move, so a failed build leaves the old golden, or none, as it was.
`-Cleanup` runs only the removal.

**The unattended install** (spike record, section 1): `INSTALLDIR=<root>\golden-build\<key>` and
`VAULT_ROOT=<root>\golden-build\<key>.vault` always (omitted, the MSI installs into Program Files and `C:\Aras\Vault`);
`WEBALIAS=ah-build-<key>`; `INSTALL_DATABASE=0` (no database, no SQL rights in the installer; the build restores the
shipped backup); `INSTALL_AGENT_SERVICE=1` with the agent's properties (below); `IS_SQLSERVER_SERVER=(local)`, `IS_SQLSERVER_DATABASE=arashouse_build_<key>`,
`IS_SQLSERVER_AUTHENTICATION=0`; `SQL_SERVER_LOGIN_NAME` and `_REGULAR_NAME` the build's logins (their defaults are the
machine-wide `innovator` logins); `REBOOT=ReallySuppress`, `MSIRESTARTMANAGERCONTROL=Disable`;
`MsiHiddenProperties=LICENSEKEY;IS_SQLSERVER_PASSWORD;SQL_SERVER_LOGIN_PASSWORD;SQL_SERVER_LOGIN_REGULAR_PASSWORD;OAUTH_CERTIFICATES_PASSWORD`.
No password and no licence key is passed to the MSI. Each public property must be a row of the MSI's Property table
(`media check`'s names, and again inside the step), or the install is refused before it starts; the one exception is
`INNOVATOR_TO_SERVICE_ADDRESS`, which the 14.x custom actions read but whose Property table has no row for it.

## The agent service

Ticket 33b. Every golden built before it had no agent (`INSTALL_AGENT_SERVICE=0`, `service.json` `installed: false`),
so `get --agent` was refused. A build now installs the agent with the rest, records it as the template a slot's
`ArasHouseAgent_<key>_<NN>` is made from, and removes it with the throw-away instance. What the MSIs do with it, read
from their tables and shipped files (non-elevated, read-only, 2026-10-28):

| | 12.0 (`12sp9`) | 14.x (`23`, `35`: the same components) |
|---|---|---|
| Service | a `ServiceInstall` row: `ArasInnovatorAgent_[AS_FOLDER]`, own process, automatic start, LocalSystem; `ServiceControl` starts it at install and stops and deletes it at uninstall | no `ServiceInstall` row: the custom action `StartAgentService` makes and starts it, `RemoveAgentService` removes it at uninstall; `CheckAgentServiceExists` aborts the install when `ArasInnovatorAgent_<AS_FOLDER>` exists |
| Executable | `AgentService\Aras.Server.Agent.Service.exe` (.NET Framework 4.7.2), no arguments | `AgentService\bin\Aras.Server.Agent.Service.exe --service` (.NET 6 in `23`, 8 in `35`) |
| Host | WCF, `basicHttpBinding`, base address `http://[AS_HOST]:[AS_PORT]/[AS_FOLDER]`, WSDL by HTTP GET | Kestrel, `Kestrel:Endpoints:HTTP:Url`, a `/health` route |
| Config the MSI writes | `Aras.Server.Agent.Service.exe.config` (XML table): the base address and `appSettings` `InnovatorServer` | `appsettings.json` (search and replace): `http://0.0.0.0:8734/` becomes `INNOVATOR_TO_SERVICE_ADDRESS`, the server URL `ARAS_AGENTSERVICE_TO_INNOVATORSERVER_URL` |
| Server config | `<AgentService InnovatorToServiceAddress="http://[AS_HOST]:[AS_PORT]/[AS_FOLDER]">` | `<AgentService InnovatorToServiceAddress="http://[AS_HOST]:[AS_PORT]/">`; `AS_PORT` is parsed from `INNOVATOR_TO_SERVICE_ADDRESS`, and `ValidateAgentServicePort` refuses an occupied port |

The build's properties: `AS_FOLDER=ah-build-<key>` (never the default `ArasInnovatorAgent`, which the captain's installs
may use; the service is `ArasInnovatorAgent_ah-build-<key>`), `AS_HOST=localhost`, `AS_PORT` the build's own port
(`8800 + 100 x flavor index`: 8800, 8900, 9000, below the flavor's first slot and never the 8734 the captain's agents
listen on), `INNOVATOR_TO_SERVICE_ADDRESS` the matching address (`http://localhost:8800/ah-build-12sp9`,
`http://localhost:8900/`), and `ARAS_AGENTSERVICE_TO_INNOVATORSERVER_URL` the build's own server (its default names
`/InnovatorServer/`, the captain's alias).

The service's name matches the deny-list prefix `ArasInnovatorAgent_`, so the build treats that one name, and only
it, as its own: the fingerprints (below) leave it out, the survey reports it by name (so a leftover is found and a
build refuses to start over it), `verify` starts it only by that name and only when its executable is in the build
folder, `stop` and `remove` stop it through the service manager (the MSI sets it to restart when its process ends) and
`remove` deletes it by that name if the uninstall did not. A provision's or destroy's fingerprints (`slot-steps.ps1`)
leave out the three build names as well, since one may run while a build has its agent: without that, a provision
overlapping a build was quarantined for a "new" deny-listed service. No other guard is loosened, and no slot service is
ever named `ArasInnovatorAgent_*`.

`service.json`:

```json
{ "schema": 1, "installed": true, "name": "ArasInnovatorAgent_ah-build-12sp9",
  "binaryPath": "AgentService\\Aras.Server.Agent.Service.exe", "startMode": "Auto", "arguments": null }
```

`binaryPath` is relative to the tree (the build checks the file is in the new golden's tree); `arguments` is what
follows the executable in the service's command line, with the install directory written `{{tree}}`, or null. A
provision makes `ArasHouseAgent_<key>_<NN>` from it, Manual and stopped, on the slot's reserved port; the edit list
points the agent's config at the slot (`docs/edits.md`), and `startSlot` asks its health URL (`docs/start-stop.md`).

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
  service.json      the agent service's definition (ticket 33b), or, in an older golden, that there is none
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
- every service whose name starts `ArasInnovatorAgent_`: its binary, start mode and account, except the build's own
  `ArasInnovatorAgent_ah-build-<key>`, which appears with the install and goes with the removal (above);
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
  `lic_type` and `company` the MSI wrote. It stores it nowhere: the slots' licence is stored separately, by
  `scripts/store-licence.ps1` (`docs/secrets.md`).
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

## Measured: the `23` golden (2026-10-27, ticket 26)

Built in one run through firstmate's elevated gate (the captain's Windows login, no prompt), from `media/23`'s Release 23 CD image
zip (MSI 424.1 MB, SHA-256 `0010987efd0b...`), with the login and the engine check: the bundle was written with
`--engine-check` (import-export-libs-js `99c19b98`, the commit spike 07 used), and the whole `<License>` element of
line 14 came from the captain's Aras28 config, read read-only by a one-off gate wrapper outside the repo (spike 07: the
14.0 SP18 key serves 14.0.9). The first run passed; every step, in seconds: preflight 2.6, snapshot 1.6 (35 objects
fingerprinted), msi-copy 1.5, msi-cost 21.2, **install 191.2** (MSI exit 0), pools 68.4, database 1.6, configure 0,
verify 46.2 (cold start, login and engine check included), stop 10.2, blank-secrets 0, capture-tree 21.4, capture-db
0.6, metadata 0, **manifest 260.5**, promote 0.1, **remove 270.2**, deny-list 2.0 (all 35 unchanged), seal 64.9.
**Total 964 s (16.1 minutes)**; `leftovers: []`.

| | |
|---|---|
| Server build | `14.0.9.36073` (`Aras.Server.Core.dll`), as the registry says |
| Patch | none: `Utilities\Aras Innovator 23 Patch.zip` upgrades 14.0.0 to 14.0.8 to the build the MSI already installs (spike 07) |
| Prerequisites | IIS, .NET Framework 4.7.2+, ASP.NET Core 6 and the ASP.NET Core Module V2 (the 6.0 Hosting Bundle): present, preflight passed |
| Tree | 26,283 files, 744.7 MB copied; **26,280 files, 744.6 MB in the manifest** (3 runtime files left out) |
| Manifest hash | `5ec98f8514449ce783721a28ea493f8359e0cdbfe87420eded29b3a506470e87` |
| IIS | 6 applications (no `/NotificationServer`, unlike `12sp9`): `/ah-build-23` and `/Client`, `/Server`, `/OAuthServer`, `/SelfServiceReporting`, `/Vault` |
| Edit list | the same eight config files as `12sp9` (spike 07): no extra OAuth, vault or agent file |
| Databases | `Core140.bak` 12.0 MB and `CoreAndSolutions140.bak` 14.5 MB (shipped); `ootb.bak` 82.1 MB (after the checks and the login, `COPY_ONLY`) |
| Agent | none (`service.json`: `installed: false`) |
| Login check | passed: an OAuth password grant as `root` with the shipped password |
| Engine check | passed: `aras-pkg export --engine 14.0.7` of the shipped `Part` ItemType (login gate and version probe) |

`DBList.aspx` is at `/<alias>/Server/DBList.aspx` in `23` as in `12sp9`. From WSL as the worker, through the broker:
`arashouse baseline verify 23` passed in 2.1 s (golden level, 26,280 files), `--full` in 11.6 s, and `arashouse
doctor` reports `ok baseline 23`. The `35` golden below was built before the engine check existed; its `-Replace`
rebuild (below) can run it with `--engine-check`.

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

## Measured: the goldens with the agent (2026-10-28, ticket 33b)

Each rebuilt with `-Apply -Replace` through firstmate's elevated gate (the captain's Windows login, no prompt), without
the login check (no licence in a gate run), from the same media as before.

**`12sp9`**: one run, 786 s, `leftovers: []`. Step by step (seconds): preflight 2.5, snapshot 1.4 (35 objects),
msi-copy 4.9, msi-cost 8.9, **install 128.8** (MSI exit 0, the agent's service made and started by the MSI), pools
66.4, database 1.8, configure 0, verify 15.9, stop 7.5, blank-secrets 0, capture-tree 17.2, capture-db 0.8, metadata
0, **manifest 277.2**, promote 4.4, **remove 184.0**, deny-list 1.9 (all 35 unchanged), seal 62.3. `verify`: "agent
ArasInnovatorAgent_ah-build-12sp9 (AgentService\Aras.Server.Agent.Service.exe, Auto) answers
http://localhost:8800/ah-build-12sp9?wsdl with 200". Tree 23,818 files, 560.7 MB; **manifest 23,815 files, hash
`d30c857941e3dc815e3e881a33ca7581a30618d6cf68cc6a2c413f58a9dfff3a`** (55 files and 3.3 MB more than the golden without the agent). `ootb.bak`
77.1 MB. `service.json`: `installed: true`, `binaryPath` `AgentService\Aras.Server.Agent.Service.exe`, `startMode`
`Auto`, `arguments: null`. The manifest leaves out the same 3 runtime files as before: the agent writes nothing into its tree.

**`23`**: one run, 997 s, `leftovers: []`. preflight 3.0, snapshot 1.4, msi-copy 1.4, msi-cost 17.4, **install 191.6**
(the custom action made and started the service), pools 94.4, database 3.2, configure 0, verify 25.2, stop 11.4,
blank-secrets 0, capture-tree 33.5, capture-db 2.0, metadata 0, **manifest 294.0**, promote 5.9, **remove 241.6**,
deny-list 1.6 (all 35 unchanged), seal 69.1. `verify`: "agent ArasInnovatorAgent_ah-build-23
(AgentService\bin\Aras.Server.Agent.Service.exe, Auto) answers http://localhost:8900/health with 200". Tree 26,390
files, 755.0 MB; **manifest 26,387 files, 754.9 MB, hash `eaa409f71c1e8959a4592172e25601ba8ec98aac4d81a1e1e28c673df004b395`**
(107 files and 10.3 MB more than without the agent). `ootb.bak` 74.1 MB.

**`35`**: one run, 835 s, `leftovers: []`. preflight 2.3, snapshot 1.4, msi-copy 1.4, msi-cost 11.7, **install 155.6**,
pools 53.9, database 1.8, configure 0, verify 33.4, stop 10.3, blank-secrets 0, capture-tree 19.3, capture-db 0.9,
metadata 0, **manifest 233.9**, promote 5.0, **remove 244.5**, deny-list 1.5 (all 35 unchanged), seal 57.9. `verify`:
`http://localhost:9000/health` answered 200. Tree 23,652 files, 1,117.9 MB; **manifest 23,649 files, 1,117.8 MB, hash
`03fb2ba2c5d252fcd90312478f76fb220715c5b1bcfb5c7d444d27c494ef2417`** (113 files and 11.1 MB more). `ootb.bak` 109.1 MB.

The 14.x service runs `"<tree>\AgentService\bin\Aras.Server.Agent.Service.exe" --service`: `service.json` records
`arguments: "--service"`, and a slot's service carries it (below, `docs/start-stop.md`). Neither 14.x agent wrote into
its tree while it ran (no `logs\` folder; the manifests leave out the same 3 runtime files), so no runtime directory is
added. These rebuilds ran without the login and engine checks (no licence in a gate run); the earlier builds of the
same media proved both (above). The `12sp9` rebuild likewise.

## For later tickets

- **Slots (ticket 25)** are mirrored from golden by robocopy, which copies no ACL, into `slots\`, whose ACL names no
  IIS account either: a slot needs the same grant as the build (`IIS_IUSRS`, or its own pool identities, modify on
  its tree and vault, including the files of `OAuthServer\App_Data`), or its OAuth server cannot open its SQLite file.
  Done: a provision grants `IIS_IUSRS` on the slot folder before the mirror, so every file inherits it (`docs/provision.md`).
- **`DBList.aspx` lives at `/<alias>/Server/DBList.aspx`** in `12sp9` and `35` (the MSI's File table; `/<alias>/DBList.aspx`
  answered 404 on the build). The WSL probe (`src/host/probe.ts`, `docs/slot-url.md`, ticket 29) asks
  `/<alias>/DBList.aspx`; ticket 32 (or a fix to 29) should use the `/Server` path, which `23` shares (ticket 26).
- A slot's licence needs the whole `<License>` element, not `lic_key` alone (run 5). Done (ticket 34b): the edit list
  sets `act_key`, `lic_type` and `company` with `lic_key`, and the secret store keeps the four together
  (`docs/secrets.md`). A golden whose `edits.json` predates it renders the key alone, so it needs a `--replace` rebuild.
- **Rebuild `23` and `35` after ticket 25.** The broker can use and drop a restore of a golden's `ootb.bak` only when
  that database's owner is `NT SERVICE\ArasHouseBroker`; ticket 25's builder fix sets it and records `ootbOwner` in
  `flavor.json`. Once it merges, both goldens built before it need `baseline build <key> --replace` (with
  `--engine-check`) and `-Apply -Replace`.
