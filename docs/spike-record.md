# Spike record: slice 0 exit (tickets 05, 06, 07; 08 recorded separately)

Written 2026-10-27 for ticket 09. It condenses the three spike records in this folder into the answers the later tickets build on:
[spike 05](spike-05-12sp9-baseline-and-clone.md) (12 SP9 install, clone, licence), [spike 06](spike-06-reset-mechanics.md) (reset mechanics
and times) and [spike 07](spike-07-release-23.md) (Release 23). Those records carry the raw numbers; this one carries the decisions. Only the
transport check (section 5) was measured for this record. No secret, licence value or password is in this file.

Flavor `35` (Release 35, 14.35) is ticket 08, recorded in [spike 08](spike-08-release-35.md): a native slot is built the same way as a
Release 23 slot, and the 14.0 key serves it. Nothing in this record waits for it.

## 1. Per flavor: install, layout, prerequisites

| | `12sp9` | `23` |
|---|---|---|
| Server build | `12.0.0.24090` | `14.0.9.36073` (MSI File table and installed tree) |
| Media | `media/12sp9/12.0 SP9 CD Image.zip` (truncated after the early entries; `scripts/spike-sync.sh --media 12sp9` extracts what is needed) | `media/23/Release 23 CD Image.zip` |
| Backups | `Core120.bak`, `CoreAndSolutions120.bak` (CD root) | `Core140.bak`, `CoreAndSolutions140.bak` |
| Patch | none | `Utilities\Aras Innovator 23 Patch.zip` upgrades 14.0.0–14.0.8 to 14.0.9; **not part of the baseline** |
| Install time (with database / without) | 295–642 s / 126 s | 611 s / 275 s |
| Tree (without `DB\`) | 23,763 files, 557 MB | 26,282 files, 745 MB |
| IIS applications | 7: `/<alias>`, `/Client`, `/Server`, `/NotificationServer`, `/OAuthServer`, `/SelfServiceReporting`, `/Vault` | 6: the same without `/NotificationServer` |
| Runtime | .NET Framework 4.0 pools for the Innovator apps; ASP.NET Core for OAuth and Vault | ASP.NET Core 6 out of process for every app but `/SelfServiceReporting` (`Aras.Server.exe`, `Aras.Client.exe` next to `w3wp.exe`) |
| Prerequisites | .NET Framework 4.7.2+ (4.8.1 present); an ASP.NET Core runtime for OAuth/Vault | the same plus the ASP.NET Core 6 Hosting Bundle and ASP.NET Core Module V2 (6.0.36 and 16.0.24290 present). **Nothing is missing on the host.** |
| Cold first request, brand-new slot | 12–15 s | 37 s |

**The unattended install that works** (both flavors, the same property set; spike 05 table 1, spike 07):
the Windows Installer COM API (`InstallProduct`, UI level none), or `msiexec /i` with the same properties, on **a copy of the MSI with a new
ProductCode** (`spike/09-new-product-code.ps1`; the shipped MSI shares the ProductCode of the captain's installs and otherwise runs in
maintenance mode on them). Properties:

- `INSTALLDIR=C:\aras_installations\...\<flavor>` and `VAULT_ROOT=...` **always** (Directory-table keys, not Property rows; omitted, the MSI
  installs into `C:\Program Files (x86)\Aras\Innovator` and `C:\Aras\Vault`, which is how the captain's Release 23 install was damaged in
  spike 05). Cost the package first and refuse if any component folder resolves outside the arashouse root.
- `WEBALIAS`, `IS_SQLSERVER_SERVER=(local)`, `IS_SQLSERVER_DATABASE`, `IS_SQLSERVER_AUTHENTICATION=0` (Windows), `SQL_SERVER_LOGIN_NAME`,
  `SQL_SERVER_LOGIN_REGULAR_NAME` (their defaults are the machine-wide `innovator` logins), the two login passwords (generated).
- `INSTALL_DATABASE=0` **works**: no database, no logins, no SQL rights needed; the baseline restores the CD's backup itself.
- `INSTALL_AGENT_SERVICE=0` (no agent executable in the tree). If an agent is wanted, set `AS_FOLDER` to an arashouse name: the 14.0 MSI
  aborts when `ArasInnovatorAgent_<AS_FOLDER>` exists.
- `REBOOT=ReallySuppress`, `MSIRESTARTMANAGERCONTROL=Disable` (the MSI's `CloseRestart` restarted the laptop once).
- `MsiHiddenProperties` naming the SQL passwords and the generated OAuth certificate password; even so **the verbose MSI log holds the SQL
  passwords**, so it is never kept.

**`C:\aras_installations`**: yes, the install directory can sit there; every spike install did.

**What a slot needs** (one per slot, never shared): one tree, one alias with its applications **on pools of its own** (`<alias>-<role>`; the
MSI puts them in machine-wide pools the captain's installs share, so the builder moves them), one database with two per-slot logins
(`_dbo`, `_reg`), one vault folder, and port 80 on `Default Web Site`. The agent (optional) uses `http://localhost:<port>/` (MSI default
8734, which the captain's install may hold). Out-of-process 14.0 apps listen on loopback ports the ASP.NET Core Module picks.

**Config files to edit per slot** (feeds `edits.json`, ticket 19): the same eight for both flavors, and nothing else names the source:

| File | Edit |
|---|---|
| `InnovatorServerConfig.xml` | `<DB-Connection database dbo_uid dbo_pwd regular_uid regular_pwd>` (12.0 attribute names, also in 14.0), `<License lic_type lic_key act_key company>`, tree paths, `<AgentService InnovatorToServiceAddress>` |
| `SelfServiceReportConfig.xml` | database |
| `OAuthServer\OAuth.config` | the alias (20 places: `many`) |
| `OAuthServer\OAuthServer.config` | `InnovatorServerUrl` |
| `VaultServer\vault.config` | `InnovatorServerUrl`, `LocalPath` (the slot's vault folder) |
| `Innovator\Client\Innovator.xml`, `Innovator\Server\Innovator.xml`, `SelfServiceReporting\SelfServiceReport.xml` | the absolute `ConfigFilePath` |

Missing any of the last four leaves a slot running on another slot's configuration; every login then fails with `Object reference not set to
an instance of an object`. No `ConversionServerConfig.xml` and no agent config exist with the default feature set. OAuth certificates are
copied with the tree, so the slots of a flavor share them.

## 2. Licence

| Question | `12sp9` | `23` |
|---|---|---|
| Is a key needed to log in? | **Yes.** Blank `lic_key`: `Missing lic_key directive in the control file.` | **Yes**, the same error |
| Is a key needed to install? | No (`LICENSEKEY` was not set; the key was written into the config afterwards) | No |
| Does one key serve two slots? | **Yes**, also after recycles and a full stop/start | **Yes**, the same |
| Other keys | n/a | **The 12.x key is refused** (`License Key is invalid.`). **A 14.0 SP18 key is accepted** by both 14.0.9 slots. |

**Key map:** `12sp9` → line `12`; `23` → line `14`; `35` → line `14` (ticket 08 found the 14.0 key accepted by 14.35). So the tool asks
for **two keys** (12 and 14). A key is needed for **login**, not for install.

**The captain's "single key" belief held in part.** One key serves every slot of its release line on this machine (tested with two slots per
line), but one key does not cover 12 and 14: a key belongs to a release line, not to a service pack and not to all of Aras. Not tested:
more than two slots, another machine.

How the spike got the keys: `spike/30-licence-reuse.ps1` read them from the captain's installed configs, never printed them. The tool itself
must not read the captain's installs (AGENTS.md rule 2): the captain types each key once at ticket 23's prompt.

## 3. Reset budget

Measured on `12sp9` with Defender on and a warm file cache (spike 06):

| Step | Seconds |
|---|---|
| Quiesce: stop the slot's pools | ~0 until unlocked (plus IIS's own stop, a few seconds at most, not timed) |
| Mirror `robocopy /MIR /XJ /R:2 /W:1` golden → slot | 0.3 clean, 0.3 dirty, 0.5 very dirty (500 files), 1.0 over a used slot; `/MT:8` = `/MT:16` |
| Re-render the 8 config files | not timed (small XML writes) |
| Restore `CoreAndSolutions120.bak` `WITH REPLACE` | 1.35–1.73 |
| Fix-ups (2 user remaps, marker) | not timed (four statements) |
| Start pools, first request (warm-up) | 2.1–2.5 |
| Health (login, version) and per-lease password edit | not timed (a few requests) |
| **Total** | **about 10 s** (about 5 s measured; the rest is small requests) against the design's 20–60 s |

`23`: not measured as a reset. Its restore is 1.3 s, and its tree mirror is a delta copy like 12's, so the same order holds for those steps;
the open number is the first request after a pool start of the out-of-process apps (a brand-new slot took 37 s against 12's 12 s). Budget
for `23`: under a minute in the worst case; ticket 36 measures it.

**Verdict: (a).** A background reset after `return`, with `get` falling back to an inline reset, is enough; nothing heavier (VHDX, ReFS)
is needed. This is what ticket 14 implemented (`docs/reset.md`). Unmeasured and worth one number in ticket 35: the mirror with a cold cache
after a reboot, and Defender off.

**Per-slot RAM.** One lightly active `12sp9` slot (logged in, one OData request): 365–373 MB across its worker processes, 0 MB once idle (the
pool idles out). SQL Server's process: 1.33 GB, shared by every database on the instance. Planning number: **1 GB per active slot**
(measured 0.4 GB light, rounded up for exports and the browser client); `23` must be measured by process tree (`Aras.Server.exe`,
`Aras.Client.exe`), not `w3wp.exe` alone. **`max_active` 3 fits**: about 3 GB on the Windows side next to SQL's shared 1.3 GB, against the
design's 6 GB. The slots run on Windows, so the WSL cap (ticket 44) must leave that room. The governor's default `min_free_ram_mb` is 2048
(the design's 2 GB); 1024 matches the measurement (ticket 38 confirms under load).

## 4. Quiesce method and SQL restore mechanism

**Quiesce: stop the slot's application pools** (and its agent service, if running). While a slot serves, 71 files are locked, all under
`OAuthServer\Bin\`. Stopping the pools releases every lock at once **and** ends the worker processes, which closes Aras's pooled SQL
connections before the restore. `app_offline.htm` also releases the file locks (0.6 s) but leaves the SQL connections, so it is not used.
The instance serves the mirrored tree with no recycle. Never check files one by one: a PowerShell exclusive-open loop over the tree took
390–725 s while serving and 8.6 s stopped.

**Mirror, then re-render.** `robocopy /XF` matches source-side paths, so slot-side exclusions do not protect the slot's configs. The reset
mirrors everything and writes the slot's eight config files again afterwards.

**SQL restore: the owner restore.** A login with no server role (neither `dbcreator` nor `sysadmin`) that owns only the slot database
restored it `WITH REPLACE, MOVE ... TO C:\aras_installations\sqldata\<db>\<db>_1.mdf / _2.ldf` in 1.36–1.68 s and **stayed the owner**.
No `EXECUTE AS` procedure is needed for a reset. Limits found:

- Another session in the database blocks the restore (`3101`). Stopping the pools removes Aras's own sessions. A foreign session (someone's
  SSMS, a pooled `sysadmin` connection) is the remaining case: as owner, `SET SINGLE_USER WITH ROLLBACK IMMEDIATE` timed out (`5061`)
  against a `sysadmin` session. Ending a foreign session needs server-level rights (`KILL`), which a Windows administrator does not have in
  SQL by that fact alone, and which a broker login outside `sysadmin` must get through a narrow, name-checked procedure. The `EXECUTE AS
  OWNER` procedure route was not proven (its run hit the same leftover session); its allowlist guard worked (`50001` for a foreign name).
- Creating a slot database (provision) still needs `CREATE ANY DATABASE` or a privileged procedure; the owner restore covers only resets of
  databases the login already owns.
- `sa` is not usable: the captain's guess and a typed value were both rejected. **Windows authentication as the elevated captain**
  (`sysadmin`) works, and the MSI accepts `IS_SQLSERVER_AUTHENTICATION=0`. This is the fallback the captain named in the ticket 03 answers.
- The SQL service account is `NT Service\MSSQLSERVER`; it reads `.bak` files under `C:\aras_installations\staging\` and golden-style
  folders.

**Fix-ups after a restore** (both flavors): remap `innovator` and `innovator_regular` to the slot's logins with `ALTER USER ... WITH LOGIN`;
nothing else from the CD's SQL scripts (they hard-code the machine-wide `innovator` logins and must not run). No owner change, no URL to
patch (`VAULT_URL_PATTERN` is alias-relative; the other absolute URLs are OOTB content), no role membership on 14.0 (12 carries
`sql_dependency_subscriber`). Write the marker (`arashouse.*` extended properties) after the restore. **Passwords for `root` and `admin`**
are set through the slot's own server (AML `edit` on `User` as `root`), not in SQL: a plain MD5 written into `[USER].password` after an edit
was refused. So the reset can randomise them only once the server is up, and the broker must keep the random `root` password of a free slot
(machine-scope secret) to log in and set the lease's password at `get`.

## 5. Transport from WSL

Measured 2026-10-27 12:35 UTC from this WSL (kernel 6.18.33.2, 14 CPUs) to Windows Node v24.13.0, 20 runs each, wall time per call
including process start, with the working directory on `C:` (a `\\wsl.localhost` working directory makes `cmd.exe` print a UNC warning):

| Call | Median | p90 | Range |
|---|---|---|---|
| `cmd.exe /c node.exe -e <print ok>` | 147 ms | 160 | 131–174 |
| `cmd.exe /c C:\PROGRA~1\nodejs\node.exe -e ...` | 136 ms | 152 | 119–155 |
| `/mnt/c/Program Files/nodejs/node.exe -e ...` (interop, no `cmd.exe`) | 92 ms | 105 | 75–115 |
| `cmd.exe /c exit 0` | 70 ms | 75 | 61–79 |
| `powershell.exe -NoProfile -NonInteractive -Command ...` | 446 ms | 484 | 379–489 |
| WSL-native `node -e ...` (reference) | 64 ms | 72 | 56–76 |
| **Named-pipe ping**: `cmd.exe /c node.exe` client → `\\.\pipe\...` → a Windows Node echo server → reply | **191 ms** | 199 | 164–200 |

Inside the client, the pipe connect + request + reply took 2.9 ms; the rest is starting `node.exe` through interop. **For ticket 20:** a
named pipe with a Windows-side Node client costs about 0.1–0.2 s per call, well under a second; start `node.exe` directly through interop
(about 90 ms) rather than through `cmd.exe` (about 150 ms), and never through `powershell.exe` (about 450 ms). The pipe in this test was a
throw-away created by the unelevated user; the ACL and the broker's service identity are ticket 20's and 21's. A Windows-side process
cannot write to `\\wsl.localhost\` paths (spike 07), so the client returns data on stdout.

## 6. The captain's questions

Answered:
- **Q3 (licence keys)**: two lines, 12 and 14 (35 pending ticket 08); a key is needed to log in, not to install; one key per line serves
  every slot of that line. Section 2.
- **Q5 (is the 12.0.0 MSI 12 SP9?)**: yes, the installed server reads `12.0.0.24090`.
- **Q1 ("23")**: Release 23 is 14.0.9.36073, confirmed from the MSI and the installed tree (the captain's own `Aras\Innovator` install,
  the first evidence, no longer exists).
- **Q7 (Release 35 media)**: superseded: the CD image is in `media/35/`; ticket 08 is running.
- **Q2 (does the broker keep `sa`?)**: moot as asked: `sa` does not work on this instance, and Windows authentication as the elevated
  captain does. Nothing to keep; setup-sql runs in the captain's elevated session.

Raised:
- **Q8. The captain's Release 23 install was removed** (spike 05, with the captain's consent; its database `InnovatorSolutions` and the
  `innovator` logins were kept). Does the captain want it back? It is outside arashouse's scope (rule 2) and arashouse will not reinstall it.
- **Q9. Defender exclusion for `C:\aras_installations`**: not needed for speed (a reset is about 10 s with Defender on). It stays an
  optional item in ticket 44, default off.
- **Q10. Foreign SQL sessions.** May the broker end other sessions in an `arashouse_*` database (through a name-checked procedure) when a
  reset is blocked, or should the slot be quarantined until the session goes away? Default: end them, through the procedure, only in
  `arashouse_*` databases.

## Map amendments made with this record

On the wayfinder map (firstmate side), 2026-10-27:
- **Frontier and Q7**: flavor `35` is not deferred; its media is present and ticket 08 is in progress.
- **Q2, Q3, Q5, Q1** marked answered as above; Q8–Q10 added.
- **Host facts**: per-slot RAM measured (1 GB planning, 0.4 GB light), `sa` rejected, Windows authentication used, the captain's Release 23
  install removed, transport latencies.
- **Risks**: licence reuse proven per line; reset time and RAM resolved; SQL permission model resolved for resets (owner restore), open for
  create and kill.
- **Tickets with a `Spike note:` line**: 19, 20, 21, 22, 24, 25, 26, 30, 31, 32, 33, 34, 36, 38, 44 (08 is in progress and
  writes its own answer; its addendum lands here). Header lines changed for `sa`: 22, 24, 25. The changes that alter a ticket's
  plan: 22 (no `sa`; the restore procedure is not needed; create and kill still need privilege), 31 (no owner fix, no URL patch; password
  randomisation moves after the server is up), 34 (`pwcrypt.exe` not used; AML edit; the broker keeps a free slot's `root` password), 30
  (stop pools, no `app_offline.htm`, no `/XF`), 33 (stop pools is the stop), 25 (per-flavor application list measured; own pools).

## Code follow-ups this record implies (not done here)

- `src/core/flavors.ts:79-80,94-95`: `licence.required` is `"to-install"` and marked provisional; the spike says `"to-login"` for `12sp9`
  and `23`. Line `35` stays provisional until ticket 08.
- `src/core/flavors.ts:33-38`: `RUNTIME_DIRS` lists `Server/temp`, `Server/dll`, `Server/logs`, matched as prefixes from the tree root
  (`src/core/manifest.ts:135-155`), but the installed tree has the server under `Innovator\Server\`, so the rules match nothing. They should
  read `Innovator/Server/temp` and so on (ticket 28 or 30 fixes it). `Innovator\Client\jsBundles\data.json` is also runtime-written (spike 06).
- `src/core/config.ts:26-33`: `min_free_ram_mb` 2048 from the design; the measurement suggests 1024 (ticket 38 decides).
