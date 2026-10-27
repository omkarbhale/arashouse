# Spike 05: a 12 SP9 baseline, a clone, and one licence key for both

Recorded 2026-10-26 and 2026-10-27 on the captain's laptop (Windows 11, IIS, SQL Server 2019 15.0.2190.7, .NET Framework 4.8.1), with throw-away
names only (`ah-spike-12sp9-*`, `arashouse_spike_12sp9_*`, `C:\aras_installations\spike\`). Scripts: `spike/09` to `spike/30` and `spike/90`.
Raw results (names, booleans, counts; no secrets) were `C:\aras_installations\spike\out\*.json`. Everything below is measured, not assumed.

## Answer

**1. The unattended install that works.** The 12 SP9 `InnovatorSetup.msi` (version 12.0.0, server `12.0.0.24090`) installs through the Windows
Installer COM API (`InstallProduct`, UI level none), in 295 s with a database and 126 s without. Properties that were needed, all non-secret
except the two generated passwords:

| Property | Value | Why |
|---|---|---|
| `INSTALLDIR` | `C:\aras_installations\spike\golden-build\12sp9` | **Not a row of the Property table**; a Directory-table key. Omitted, the MSI installs to `C:\Program Files (x86)\Aras\Innovator`. |
| `VAULT_ROOT` | `C:\aras_installations\spike\vaults\12sp9-a` | Another Directory key; its default is `C:\`, so the vault lands in `C:\Aras\Vault`, shared with the captain's other installs. The vault folder becomes `<VAULT_ROOT>\Aras\Vault\`. |
| `WEBALIAS` | `ah-spike-12sp9-a` | The IIS alias. |
| `INSTALL_DATABASE` | `1`, or `0` | See 3. |
| `IS_SQLSERVER_SERVER`, `IS_SQLSERVER_DATABASE` | `(local)`, `arashouse_spike_12sp9_a` | |
| `IS_SQLSERVER_AUTHENTICATION` | `0` | `0` is Windows authentication, `1` a SQL login (from the MSI's own `CheckDBAConnection` script). The captain's `sa` password was rejected, so the elevated user's own sysadmin login was used. |
| `SQL_SERVER_LOGIN_NAME`, `SQL_SERVER_LOGIN_REGULAR_NAME` | `arashouse_spike_12sp9_a_dbo`, `..._reg` | Default to the shared `innovator` and `innovator_regular`. |
| `SQL_SERVER_LOGIN_PASSWORD`, `SQL_SERVER_LOGIN_REGULAR_PASSWORD` | generated | Secret. |
| `INSTALL_AGENT_SERVICE` | `0` | No Windows service is created. |
| `CHANGEGUID` | `1` | Present in the MSI; not needed once the MSI has a new ProductCode. |
| `REBOOT=ReallySuppress`, `MSIRESTARTMANAGERCONTROL=Disable` | | The MSI sets `RestartManagerOption=CloseRestart`; see "Surprises". |

**The MSI must have its own ProductCode.** `media/12sp9/InnovatorSetup.msi` has the ProductCode of the captain's installed Aras12. `msiexec`
then runs in maintenance mode on *that* install and ignores `INSTALLDIR`: exit 0, nothing installed. Aras ships `ChangeGUID.exe` for this
(`ChangeGUID new <display version> <msi>`, run on a copy). Its MSI edit is three `UPDATE` statements on the Property table (`ProductCode`,
`ProductID`, `UpgradeCode`); it also writes to the machine's installer registry for the product code it reads, which would be the captain's
product. `spike/09-new-product-code.ps1` applies only the MSI edit (plus a new package code in the summary information) to a copy under
`staging\<flavor>\instance\`; the original media is never modified. The two MSI product entries it creates uninstall cleanly with `msiexec /x
<code> REMOVE_DATABASES=0` (exit 0).

**2. What the MSI creates.**
- Tree (23,763 files, 584 MB): `DB\` (holds `Core120.bak` and `CoreAndSolutions120.bak`), `Innovator\` (Client, Server), `OAuthServer\`,
  `SelfServiceReporting\`, `Tools\`, `VaultServer\`, and at the top `InnovatorServerConfig.xml` and `SelfServiceReportConfig.xml`.
  No `AgentService\` and no `ConversionServer\` with `INSTALL_AGENT_SERVICE=0` and the default feature set.
- IIS, site `Default Web Site`, seven applications: `/<alias>` and `/<alias>/Server` and `/<alias>/Client` and `/<alias>/NotificationServer`
  (all under `Innovator\`, `Server\` for the last two), `/OAuthServer`, `/SelfServiceReporting`, `/Vault`. **The MSI puts them in fixed,
  machine-wide pools** (`Aras Innovator AppPool ASP.NET 4.0`, `Aras OAuth AppPool ASP.NET Core`, `Aras SelfServiceReporting AppPool ASP.NET 4.0`,
  `Aras Vault AppPool ASP.NET Core`) which the captain's installs share, so `10-baseline-install.ps1` moves each application onto its own pool
  `<alias>-<role>` afterwards (`root`, `client`, `server`, `notificationserver`, `oauthserver`, `selfservicereporting`, `vault`) with the same
  settings: Integrated pipeline, ApplicationPoolIdentity, 32-bit off; .NET v4.0 for the Innovator, Client, NotificationServer, Server and reporting
  pools, no managed runtime (ASP.NET Core) for OAuth and Vault; idle timeout 20 min (Innovator) or 8 h (OAuth, Vault, reporting); start mode on demand.
- Windows Installer: one product entry per install (`displayName` Aras Innovator, 12.0.0, install location under the spike folder). No Windows
  service. Program Files unchanged.
- SQL Server (with `INSTALL_DATABASE=1`): database `arashouse_spike_12sp9_a` (data 136 MB, log 136 MB), users `innovator` and `innovator_regular`
  mapped to the two named logins, and the same two users added to `master` (so a leftover makes the next install fail in `DoesDBExists`).
- Config: `InnovatorServerConfig.xml` with one `<DB-Connection id database server regular_uid regular_pwd dbo_uid dbo_pwd>` (the 12.0 attribute names; not
  `uid`/`pwd`), `<License lic_type lic_key act_key company/>`, `<AgentService InnovatorToServiceAddress=.../>`; `OAuthServer\OAuth.config` with
  redirect URIs that name the alias; `OAuthServer\OAuthServer.config` and `VaultServer\vault.config` with `InnovatorServerUrl`; `vault.config`
  `LocalPath`; `Innovator\Client\Innovator.xml`, `Innovator\Server\Innovator.xml` and `SelfServiceReporting\SelfServiceReport.xml` each hold
  `ConfigFilePath`, an absolute path.
- The agent service, from the MSI's own `ServiceInstall` table: name `ArasInnovatorAgent_[AS_FOLDER]`, display name `Aras Innovator Agent
  ([AS_FOLDER])`, own process, automatic start, error control normal, component `AgentService`; the address in the server config is
  `http://localhost:8734/ArasInnovatorAgent` by default (`AS_PORT`). Input to the ticket 25 templates.

**3. Can the install directory be outside Program Files?** Yes, with `INSTALLDIR` (see the table). **Does `INSTALL_DATABASE=0` work?** Yes: the
install ran in 126 s, touched SQL Server not at all (no database, no logins, no users), and needed no SQL admin rights. The tree then has no
`DB\` folder, so the backups come from the CD image: `Core120.bak` and `CoreAndSolutions120.bak` (about 12 and 15 MB), in the CD image's root.
Both are in `media/12sp9/12.0 SP9 CD Image.zip`, which is truncated after the early entries on the source drive (no central directory;
`scripts/spike-sync.sh --media 12sp9` extracts only what is needed and checks every size against the listing).

**4. Version.** `Aras.Server.Core.dll` is `12.0.0.24090`, which confirms the MSI is 12 SP9.

**5. The clone** (`20-clone-slot.ps1`; all rows measured):
- Tree copy (robocopy, 23,765 files, 584 MB): 14 s. Database restore of `CoreAndSolutions120.bak`: 1.2 s (data 83 MB, log 28 MB).
- Per-slot logins `..._b_dbo` and `..._b_reg` with random passwords written only into the clone's own `InnovatorServerConfig.xml`; the restored users
  `innovator` and `innovator_regular` are remapped with `ALTER USER ... WITH LOGIN`.
- Own vault folder (`vault.config` `LocalPath`), own seven applications and pools, own agent port (8800 here).
- Files to edit, by hand or by the script: `InnovatorServerConfig.xml` (database, tree paths, logins, agent port), `SelfServiceReportConfig.xml`
  (database), `OAuthServer\OAuth.config` (alias, 20 places), `OAuthServer\OAuthServer.config` (alias), `VaultServer\vault.config` (alias,
  `LocalPath`), `Innovator\Client\Innovator.xml`, `Innovator\Server\Innovator.xml` and `SelfServiceReporting\SelfServiceReport.xml` (the absolute
  `ConfigFilePath`). **Missing any of the last four leaves a clone that works on the source slot's configuration**: the first clone's OAuth server
  authenticated against the baseline and every login failed with `Object reference not set to an instance of an object`. `20-clone-slot.ps1` now
  records every remaining file that names the source.
- Cold first request of the clone's client: about 12 s. The clone logs in while the baseline stays up, and the baseline logs in while the
  clone is up.
- The agent service was not cloned: with `INSTALL_AGENT_SERVICE=0` the tree has no agent executable.

**The CD's post-restore SQL scripts** (`Utilities\add_innovator_user.sql`, `fix_innovator_user.sql`, `change_to_innovator_owner.sql`; identical in 12 SP9 and
Release 23) hard-code the machine-wide logins `innovator` and `innovator_regular` and a database named `Innovator`, so running them verbatim
would touch the captain's own databases' logins. Their steps were checked on the restored copy with per-slot names: relinking the two users is
needed (done with `ALTER USER ... WITH LOGIN`, no orphaned user left); the owner change is not needed (all 470 tables are already in the
`innovator` schema); the only role membership the restore carries is `innovator_regular` in `sql_dependency_subscriber`. The vault URL is `VAULT_URL_PATTERN` =
`$[HTTP_PREFIX_SERVER]$[HTTP_HOST_SERVER]$[HTTP_PORT_SERVER]$[HTTP_PATH_SERVER]/vault/vaultserver.aspx`, relative to the alias, so no update per slot.

**6. The licence verdict.**
- **Is a key needed for login? Yes.** With `lic_key` blank, both slots refuse every login: `invalid_grant: The Database is not available:Missing lic_key
  directive in the control file.` (so "ask only if needed" is exact: the OOTB server needs a key).
- **Does one key serve both slots? Yes.** The `<License>` element copied from the captain's installed Aras12 (type `Unlimited`, with an activation key)
  into both slots: both log in, still log in after a second recycle of all pools, and after a full stop and start of all pools.
- Scope: one key, two slots, one machine, same release. Not tested: more than two slots, a different machine, a different release (tickets 07, 08).
  The key was read from the captain's config by script, never printed, and is not in this repository.

**7. Cheap measurements.** Install 295 s (with database) and 126 s (without); tree 23,763 files, 584 MB (557 MB without `DB\`); clone copy 14 s,
restore 1.2 s, cold client 12 s; databases 136 + 136 MB (MSI-created) and 83 + 28 MB (restored). Reset timings are ticket 06.

**8. Teardown.** `90-teardown.ps1` removed both spike products (`msiexec /x`, `REMOVE_DATABASES=0`), 21 applications and 21 pools, both databases, four
logins and the `master` users, the spike folders and six ASP.NET temp folders; nothing with a spike prefix is left. Pre-flight afterwards: the
deny-list hashes of Aras12 and Aras28 match the baseline taken before the first run; the Aras\Innovator root no longer exists (see below).

## Surprises, in order of cost

1. **Two things in the captain's installs were damaged before this was understood.** (a) The first retry reconfigured the captain's Aras12 product
   (same ProductCode; only its installer source list gained the staging path). (b) The second retry, without `INSTALLDIR` set, installed 12.0.0 into the
   captain's Release 23 root (`C:\Program Files (x86)\Aras\Innovator`, alias `/InnovatorServer23`), rewriting its configs and certificates and pointing its OAuth
   and vault at the spike. The captain chose to uninstall that Aras entirely and keep its database: removed on 2026-10-27 (both product registrations, IIS apps,
   agent service, folder, vault folders); `InnovatorSolutions` and the `innovator` logins were kept. Cause: the script set only properties it found in the Property
   table. Fixes now in the scripts: `INSTALLDIR` and `VAULT_ROOT` always set; the package is costed first (`OpenPackage`, costing actions only) and the run refuses if
   any component folder or the vault resolves inside an Aras root or outside the spike folder; an MSI whose ProductCode is installed is refused.
2. **An install can restart the PC.** The MSI sets `RestartManagerOption=CloseRestart`; the second retry was running when the laptop restarted. All installs
   and uninstalls now pass `REBOOT=ReallySuppress` and `MSIRESTARTMANAGERCONTROL=Disable`, and a wanted restart is recorded as `rebootRequested`.
3. **The `sa` password was rejected** (the captain's guess `root`, and a typed value); Windows authentication as the elevated user (sysadmin) works, and
   the MSI honours `IS_SQLSERVER_AUTHENTICATION=0`.
4. **The MSI's verbose log contains the generated SQL login passwords**, even with `MsiHiddenProperties`; the secret scan deletes the log. Failures are
   therefore read from the exit code and the facts recorded, or from a log written without the password properties.
5. **The shipped backup's well-known `root` password equals the stock SQL login name `innovator`**, so a naive secret scan flagged ordinary Aras data and
   deleted result files. The scan now matches that password only after `password` or `pwd`, and only in files the run wrote.
6. The MSI's uninstall (`RemoveDatabases`) would drop every database named in the config when `REMOVE_DATABASES=1`; it is `0` by default and always set to `0` here.

## What this gives tickets 06, 24, 25

- The unit of a slot: one tree, one alias with seven applications on seven own pools, one database with two per-slot logins, one vault folder, one config
  set edited as listed above. All reproducible from a baseline tree plus a restored `.bak`; nothing needs the MSI after the baseline exists.
- A baseline needs SQL admin rights only for the restore (`INSTALL_DATABASE=0`), never in the installer.
- Never run the MSI itself for a new slot: copy the baseline tree.
