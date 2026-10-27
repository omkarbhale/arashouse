# Spike 08: Release 35 (14.35): what it needs, and a native slot

Recorded 2026-10-27 on the captain's laptop (the host of [spike 05](spike-05-12sp9-baseline-and-clone.md): Windows 11, IIS 10, SQL Server 2019,
.NET Framework 4.8.1), with throw-away names only (`ah-spike-35-*`, `arashouse_spike_35_*`, `C:\aras_installations\spike\`). Media: the Release 35
CD image zip in the main checkout's `media/35/`, unpacked to `staging\35\cd\`. Scripts: `spike/09` to `spike/30` and `spike/90` with `-Flavor 35`,
run through firstmate's elevated gate in two parts (build, then teardown); `09-new-product-code` and the engine smoke test ran unelevated. Raw
results (names, booleans, counts; no secrets) were `C:\aras_installations\spike\out\*-35*.json`. Everything below is measured or read, not assumed.

## Answer

**A native Release 35 slot is possible, and it is built the same way as a Release 23 slot.** The CD image is ordinary server media, the MSI is
the same plain MSI as 14.0.9 with the same unattended properties, the host already has every runtime it needs, the captain's 14.0 SP18 key
serves it, and the libs-js `14.35` engine logs in and exports. Server build: **`14.35.0.43890`**.

### The questions

1. **Media.** `media/35/Release 35 CD Image.zip` is a full CD image like Release 23's: `InnovatorSetup.msi` (558 MB, `ProductVersion` 14.35.0),
   `Core140.bak` (12 MB) and `CoreAndSolutions140.bak` (14.8 MB), `Utilities\` (`ChangeGUID.exe`, `pwcrypt.exe`, the three post-restore SQL
   scripts, `Aras Innovator 35 Patch.zip`), `PackageImportExportUtilities\` (the 14.35 import tool) and the documentation. The backups keep the
   `140` names but are not Release 23's files (different SHA-256). The three SQL scripts and `pwcrypt.exe` are byte-identical to Release 23's.
   The Partner Demo Environment zip is not needed for a baseline; it stays a candidate bootstrap profile (ticket 39).
2. **Prerequisites.** The Release 35 Installation Guide and Platform Specifications (on the CD) name .NET Framework 4.7.2, the ASP.NET Core
   8.0.1 Runtime and Hosting Bundle, and the Visual C++ 2015–2019 redistributable; SQL Server 2016 to 2022. The MSI itself checks only
   `NET_FRAMEWORK_RELEASE >= 461808` (4.7.2), the same launch condition as 14.0.9, and has three new message properties for a SQL
   version and compatibility-level check (`Aras_CA_SQLVersionIsNotCompatible`, `Aras_CA_CompatibilityLevelNotMatchedWithExpected`,
   `Aras_CA_LegacyCardinalityNotMatchedWithExpected`), which SQL Server 2019 passed. The installed tree is `net8.0` throughout (the Innovator
   server and client, OAuth, Vault and the agent: every `*.runtimeconfig.json` names `Microsoft.AspNetCore.App` 8.0.0), and every ASP.NET
   Core application runs **out of process** (`hostingModel="outofprocess"`). The host has the ASP.NET Core 8.0.31 shared runtime and the ASP.NET
   Core Module V2 16.0.24290 (from the 6.0.36 Hosting Bundle), and the Visual C++ 14.x runtime. That is enough: both slots served and logged
   in. **Nothing is missing and nothing was installed.** A host without the module fails with the guide's "HTTP Error 500.0, Module
   AspNetCoreModuleV2 could not be found" (Installation Guide 7.6); a host without an 8.x ASP.NET Core runtime would fail to start the
   applications.
3. **Installer shape.** Unchanged: a plain `InnovatorSetup.msi` (no bootstrapper), installed in-process through the Windows Installer COM API
   with exactly the properties 12 SP9 and Release 23 use (`INSTALLDIR`, `VAULT_ROOT`, `WEBALIAS`, `INSTALL_DATABASE`, `IS_SQLSERVER_*`,
   `IS_SQLSERVER_AUTHENTICATION=0`, `SQL_SERVER_LOGIN_NAME`/`_REGULAR_NAME`, `INSTALL_AGENT_SERVICE=0`, `CHANGEGUID=1`,
   `REBOOT=ReallySuppress`, `MSIRESTARTMANAGERCONTROL=Disable`); none missing, none extra. It needs its own ProductCode (`09-new-product-code`)
   like the others, although the original's code is not installed on this host. 215 Property rows (Release 23: 212): the 14.0.9 names plus
   the three messages above, with the same defaults. The custom actions are the same set; two VBScript bodies changed: the SharePoint
   Windows-authentication step is gone and the Self-Service Reporting database list is no longer built. No `ServiceInstall` table (as in
   14.0.9: the agent is made by custom actions). The OAuth and vault layout is the same as 14.0.9's. `INSTALL_DATABASE=0` works: 259 s, no
   `DB\` folder, no database, no SQL logins.
4. **Licence.** The same test as ticket 05 step 6, with each key read from an installed config (read only, never printed) and written into
   both spike slots:
   - no key: both slots refuse login (`Missing lic_key directive in the control file`), as on 12 and 14.0;
   - **the 14.0 SP18 key (Aras28's, type `Unlimited`, with an activation key) is accepted by both 14.35 slots**, and still after a second recycle
     and after a full stop and start of all pools;
   - the 12.x key (Aras12's) is refused by both: `License Key is invalid.`

   So the 14.0 key that ticket 07 found valid for 14.0.9 also serves 14.35: one key for the whole 14.x line (`23` and `35`) on this machine,
   and no 14.35 key or Community Edition is needed. Community Edition was not tried. The guide says a key is per server MAC address and is
   requested at `https://www.aras.com/support/`.
5. **Engine smoke.** `aras-pkg export --engine 14.35 ItemType:<Part's id>` as `root` (password from `ARAS_PASSWORD`, run under Windows
   `node.exe` as in spike 07) succeeded against both slots: the 14.35 engine's login gate and version probe accepted server `14.35.0.43890`, and
   `PLM/Import/ItemType/Part.xml` was written with an `imports.mf`. The same export with `--engine 14.0.7` also succeeded against the 14.35
   server and wrote a byte-identical `Part.xml` and `imports.mf`. This is a smoke test, not parity (tickets 45 and 46); it does mean the 14.35
   engine has a live server to meet for the first time.
6. **Build number.** `Aras.Server.Core.dll` reads `14.35.0.43890` in the installed tree and in the MSI's File table; so do `Aras.Server.exe`,
   `Aras.Client.exe`, `Aras.OAuth.Server.exe`, `Aras.Vault.Server.exe` and `Aras.Server.Agent.Service.exe`. It is the flavor registry's
   `serverBuild` for `35` now (`src/core/flavors.ts`).

### Differences from Release 23 (spike 07)

| | Release 23 (14.0 SP9) | Release 35 (14.35) |
|---|---|---|
| MSI | `ProductVersion` 14.0.9, 424 MB, 212 Property rows | `ProductVersion` 14.35.0, 558 MB, 215 Property rows (three new SQL-check messages); same properties set |
| Server build | 14.0.9.36073 | 14.35.0.43890 |
| Launch conditions | .NET Framework 4.7.2 or newer | the same |
| Install time, with database / without | 611 s / 275 s | 503 s / 259 s |
| Tree | 26,282 files, 771 MB; `DB`, `Innovator`, `OAuthServer`, `SelfServiceReporting`, `Tools`, `VaultServer` | 23,538 files, 1,133 MB (1,107 MB without `DB\`; `Innovator\` alone is 1,077 MB); **no `SelfServiceReporting`** |
| IIS applications | six: `/<alias>`, `/Client`, `/Server`, `/OAuthServer`, `/SelfServiceReporting`, `/Vault` | **five: no `/SelfServiceReporting`** |
| Runtime | ASP.NET Core 6, out of process; `/SelfServiceReporting` .NET 4.0 | **ASP.NET Core 8**, out of process; all five pools have no managed runtime |
| The MSI's shared pools | `Aras Innovator AppPool ASP.NET Core`, `Aras OAuth AppPool ASP.NET Core`, `Aras SelfServiceReporting AppPool ASP.NET 4.0`, `Aras Vault AppPool ASP.NET Core` | the same minus the reporting pool; moved onto `<alias>-<role>` pools as before |
| Pool idle timeout | 8 h on all | 8 h on all |
| Config files a clone edits | eight: `InnovatorServerConfig.xml`, `SelfServiceReportConfig.xml`, both `innovator.xml`, `OAuthServer\OAuth.config` (alias, 20 places), `OAuthServer\OAuthServer.config`, `VaultServer\vault.config`, `SelfServiceReporting\SelfServiceReport.xml` | **six**: the same minus the two reporting files, with the same edits; no file of the clone still names the source |
| `<DB-Connection>` attributes | `id database server regular_uid regular_pwd dbo_uid dbo_pwd` | the same |
| OAuth certificates | generated by the silent install, copied with the tree | the same (`OAuthServer`, `VaultServer`, `Innovator\Client` `App_Data\Certificates\`) |
| Services | none with `INSTALL_AGENT_SERVICE=0`; no agent executable in the tree | the same |
| Clone: copy / restore / cold client | 36 s / 1.3 s / 37 s | 26 s / 1.05 s / 30 s |
| Restored database (`CoreAndSolutions140.bak`) | users `innovator`, `innovator_regular`; 450 + 2 tables; no role memberships | the same users; 455 + 2 tables (`innovator`, `tz`); no role memberships; no owner change needed |
| Vault URL | `VAULT_URL_PATTERN`, relative to the alias | the same |
| Patch | `Aras Innovator 23 Patch.zip`, not needed | `Aras Innovator 35 Patch.zip` (343 MB), not needed: see below |
| Licence | a 14.x key; the 12.x key is refused | the same 14.x key; the 12.x key is refused |
| Prerequisites | ASP.NET Core 6 runtime and module V2: present | ASP.NET Core 8 runtime and module V2: present |
| Deny-list | unchanged | unchanged (`denyListUnchangedSinceBaseline: true` after the build and after the teardown) |

**The patch.** `Utilities\Aras Innovator 35 Patch.zip` is an Aras Update package (`package.config`: `ArasUpgradePackage`, version
`14.35.0.43890`, "Release 35 (14.35.0)", "Upgrades Aras Innovator Release 14 or newer to Release 35"). Its `CheckVersionCompatibility.ps1`
accepts a code tree only when its `rev.inc` has the same major version and an older minor or service update than 14.35.0. It upgrades an older
14.x to the build the MSI already installs. **The baseline does not include the patch.**

**Restore and fix-ups.** As for Release 23: remap `innovator` and `innovator_regular` to the slot's logins with `ALTER USER ... WITH LOGIN` (no
orphaned user is left); no owner change, no role membership to restore, no vault URL to patch. The CD's `fix_innovator_user.sql` is the same file
as Release 23's (two `sp_change_users_login 'Auto_Fix'` calls on the machine-wide logins), so it is not usable for per-slot logins.

### Changes for later tickets

- **09 (exit record) and 23 (secrets).** The licence verdict for `35`: the 14.x key serves it. The registry still gives `35` its own licence
  line `"35"`; ticket 09 can make it `"14"`, so the tool asks for two keys (12.x and 14.x), not three. Not changed here.
- **19 (edit list).** The 14.35 list is six files: Release 23's eight minus `SelfServiceReportConfig.xml` and
  `SelfServiceReporting\SelfServiceReport.xml`.
- **24 and 27 (baseline builder, baseline 35).** No patch in the baseline; the expected build is `14.35.0.43890`; `INSTALL_DATABASE=0` works.
  Record the ASP.NET Core 8 runtime and the ASP.NET Core Module V2 as `35` prerequisites; the builder can check both before it runs the MSI
  (the MSI checks neither). The golden tree is about 1.1 GB, half again Release 23's, so disk and mirror estimates per `35` slot grow accordingly.
- **25 (slot templates).** `iis.json` for `35`: five applications, all in pools with no managed runtime; each serving application is its own
  `Aras.*.exe` process next to `w3wp.exe`, as on 14.0.9.
- **46 (libs-js live parity).** A live 14.35 server is now buildable on this host; the export smoke passed with both `14.35` and `14.0.7`.

## Surprises

1. **The 14.0 SP18 key serves 14.35.** A key is bound to the major line (14.x), not to the release: Release 23 (14.0.9) and Release 35
   (14.35.0) both accept it, while 12.0 refuses it (and 14.x refuses the 12.x key).
2. **Self-Service Reporting is gone** from the 14.35 installer: no folder, no application, no pool, no config file.
3. **The tree is larger with fewer files**: 23,538 files and 1.1 GB against Release 23's 26,282 files and 771 MB.
4. The 14.0.7 engine also exports from a 14.35 server, with the same bytes for the item tried.

## Teardown

`90-teardown.ps1` (697 s) uninstalled both spike products (`a` and `c`; `msiexec /x`, `REMOVE_DATABASES=0`, exit 0 each), removed 15 applications
and 15 pools, dropped both databases, four logins and the two `master` users, and removed the spike folders; nothing with a spike prefix is left
(`leftover` all 0). Pre-flight afterwards: `denyListUnchangedSinceBaseline: true`. The unpacked CD media stays in `staging\35\` for ticket 27.
