# Spike 06: reset mechanics (quiesce, tree mirror, database restore, ownership) and measured times

Recorded 2026-10-27 on the captain's laptop (Windows 11, IIS, SQL Server 2019 15.0.2190.7), 12 SP9 (`12.0.0.24090`), throw-away names
only (`ah-spike-12sp9-*`, `arashouse_spike_*`, `C:\aras_installations\spike\`). The elevated steps ran through firstmate's gate in three
parts (`spike/README.md`, "The ticket 06 sitting"): rebuild the baseline `a` and the clone `b` (scripts 00, 10, 20), copy the licence (30),
then measure (40, 50, 60) and tear down (90, 00). The first measuring run kept 40's results; 50 and 60 were fixed and run again on a fresh
rebuild. Raw results (numbers, booleans, names; no secrets) were `C:\aras_installations\spike\out\*.json`. Everything below is measured
unless it says otherwise. **Defender was on for every number**: the Defender-off comparison waits for a captain decision.

## Answer

**The quiesce method: stop the slot's application pools.** While a slot serves, 71 of its 23,766 files are locked; the first 40 listed
are all `OAuthServer\Bin\*` (the OAuth server is ASP.NET Core and loads its DLLs in place). The Innovator server's own `bin` is not locked
(ASP.NET shadow-copies it). Both methods release every lock at once:

| Method | Seconds until the locked files open exclusively | Files still locked (every file tried) |
|---|---|---|
| `app_offline.htm` in each of the seven application folders | 0.6 | 0 |
| Stop the seven pools | 0 (the stop itself waits until the pools report Stopped) | 0 |

The pool stop also ends the worker processes, which closes the server's pooled SQL connections before the restore (see 3 below). So it
is the quiesce for the whole reset, and `app_offline.htm` is not needed. After the mirror, the instance served the mirrored tree with no
recycle: a file the mirror deleted returned 404 on the next request, and the first request after `app_offline.htm` was removed answered
200 in 2.5 s.

**The mirror overwrites the slot's own configuration.** A `robocopy /MIR` of the baseline over a used slot touches very little: 11 files,
of which 8 are the per-slot config files (`InnovatorServerConfig.xml`, `SelfServiceReportConfig.xml`, both `Innovator.xml`,
`OAuthServer\OAuth.config`, `OAuthServer\OAuthServer.config`, `VaultServer\vault.config`, `SelfServiceReporting\SelfServiceReport.xml`).
The other 3 are a runtime-written `Innovator\Client\jsBundles\data.json`, a `Server\temp` log and a test file. The spike meant to exclude
the config files, but the script passed slot-side paths to `/XF` and robocopy evidently matches them on the **source** side (its `/L` preview
with the same arguments listed the excluded files as copies). So the baseline's configs
landed in the slot, and every login failed with `Object reference not set to an instance of an object`, also after a recycle. That is the
same symptom as a clone left on its source's configuration (spike 05). The script now passes both sides. For ticket 30: mirror first, then
write the slot's config set again from its templates. Do not rely on exclusions.

**The reset budget for the 12.x tree, step by step** (Defender on, file cache warm):

| Step | Measured | Notes |
|---|---|---|
| Stop the seven pools | ~0 s until unlocked | Plus the time IIS takes to report Stopped (not timed separately; under a few seconds). |
| `robocopy /MIR /XJ /R:2 /W:1` baseline to slot | 0.3 s clean, 0.3 s dirty (20 added files, 1 touched config), 0.5 s very dirty (500 added files); 1.0 s over a used slot | 23,765 files, 584 MB. `/MT:8` and `/MT:16` are the same. Repeated 3 times each. |
| Write the slot's 8 config files | not measured | Small XML edits (ticket 25 templates). |
| Restore `CoreAndSolutions120.bak` with `REPLACE` | 1.35–1.73 s | As `sysadmin` or as the database's owner (below). 75 MB data, 1 MB log. |
| Fix-ups: remap 2 users, write the marker | not timed | Four short statements. |
| Start the pools; first request | 2.1–2.5 s | Anonymous `GET /<alias>/Client/`. The first request of a brand-new slot (nothing compiled yet) took 12–15 s. |
| Per-lease passwords for `root` and `admin` (AML edit as `root`) | not timed | Needs the server up; one login as `root` with the shipped password, then two edits. |

**Total: about 10 s per reset, against the design's 20–60 s estimate** (about 5 s measured; the config writes, fix-ups and password edits were not timed one by one but are a handful of small requests and statements). The stat scan the design feared (6–25 s in PowerShell) costs
robocopy under a second with a warm cache. Not measured: a mirror with a cold file cache (after a reboot, or with many slots), and
Defender off. A PowerShell loop that opens every file exclusively took 390–725 s while the slot served and 8.6 s once it was stopped. The
reset must never do per-file checks; it relies on the pool stop.

**The SQL permission result and the chosen restore mechanism: the owner restore.**
- A login with **no server role** (neither `dbcreator` nor `sysadmin`) that owns only the spike database restored it `WITH REPLACE` in
  1.36–1.68 s, and **stayed the owner** afterwards. So the pool login can own just the `arashouse_*` databases and reset them itself; no
  `EXECUTE AS` procedure is needed.
- With **another session in the database** the plain restore fails (`3101`, exclusive access). As the owner, `SET SINGLE_USER WITH
  ROLLBACK IMMEDIATE` before the restore failed too (`5061`, no lock, after 26 s). The other session was a `sysadmin` connection that
  ADO.NET connection pooling kept open after the script disposed it, so the owner could not end it. Stopping the pools closes Aras's own
  connections, so a reset does that first. A stray session of another login (someone's SSMS) still blocks the restore; the broker, being
  admin, can end it (`KILL`) and retry.
- The **`EXECUTE AS OWNER` procedure** in a utility database (`TRUSTWORTHY ON`, name allowlist inside) was not proven. Its restore hit
  the same leftover pooled session (`3101`), so the permission path was never reached. Its guard works: a name outside `arashouse_spike_*`
  was refused with the procedure's own error `50001`. It is not needed, because the owner restore works.
- **Files:** the backup holds one data file and one log (logical names `Solutions.S12-0-SP9.12.0.24090.ConvertSqlToBackup` and `..._log`).
  The restore moves them with `MOVE ... TO C:\aras_installations\spike\sqldata\<database>\<database>_1.mdf` and `_2.ldf`. Without `MOVE`
  they would go to SQL's default `C:\Program Files\Microsoft SQL Server\MSSQL15.MSSQLSERVER\MSSQL\DATA\`.
- **The SQL service account** is `NT Service\MSSQLSERVER`. It read a `.bak` from `C:\aras_installations\staging\12sp9\cd\` and from a
  golden-style folder under the spike root both before and after an explicit read grant. Ticket 39's captain-supplied `.bak` takes the
  same path.

**The fix-up list after a restore:**
1. **Users.** The restored `innovator` and `innovator_regular` are orphaned (no login). Map them to the slot's two logins with `ALTER USER
   ... WITH LOGIN` (spike 05 proved this; no orphan is left). Nothing else from `fix_innovator_user.sql` is needed, and its hard-coded
   machine-wide logins must not be used.
2. **URLs.** None to patch. The Vault item's `VAULT_URL_PATTERN` is relative to the alias (0 of 1 rows absolute). A scan of all 3,308
   string columns of the `innovator` schema found absolute URLs only in content: `REPORT.XSL_STYLESHEET` (19 rows),
   `METRIC.STYLESHEET` (11), `METHOD.METHOD_CODE` (9, 2 of them naming `localhost`), `TP_XMLSCHEMA.CONTENT` (1) and
   `SECUREMESSAGEVIEWTEMPLATE.TEMPLATE` (1). These are OOTB stylesheets, schemas and sample code, not the instance's address.
3. **Marker.** `arashouse.state` and `arashouse.golden_hash` as database extended properties, written after the restore: both present. A
   restore from a golden `.bak` without them removes them, which is what makes the marker a proof of "restored, then fixed up".
4. **Passwords for `root` and `admin`.** The shipped backup stores both as the 32-digit lower-case MD5 hex of the shipped password. The
   working route is an **AML edit through the slot's own server**: log in as `root` with the shipped password, then `ApplyItem` `<Item
   type="User" action="edit" where="[User].login_name='admin'"><password>MD5 hex</password></Item>`, the same for `root`. Both then log in
   with the new password. The server stores something other than the plain MD5 of the new password after the edit. Writing the plain
   MD5 (lower or upper case) of a new password directly into `[USER].password` for `admin` after that edit failed (`Authentication failed
   for admin`), also after a recycle. The likely cause, not checked, is a per-user salt the edit adds. Ticket 34 uses the AML route.

**Services.** `sc sdset` with an `(A;;LCRPWP;;;<user SID>)` entry lets a non-admin local user start and stop the slot's service: before
the change `sc start` was refused (5, access denied); after it, `start` returned 1053 and `stop` 1062. Those are the stand-in service's
own answers, not access errors. So a no-broker fallback for the agent is possible. The test used a stand-in service of the slot's name,
because a baseline installed with `INSTALL_AGENT_SERVICE=0` has no agent executable (spike 05).

**The per-slot memory.** One active slot (logged in, one OData request) held 365–373 MB across its worker processes. It held 0 MB once
idle: with a 1-minute idle timeout the worker processes exit. SQL Server's process stayed at 1,329–1,330 MB, shared by every database on
the instance (the captain's included), so a slot adds little to it. A restored slot database is 109 MB on disk (the MSI-created baseline
272 MB). Planning number for ticket 44: about 0.4 GB per lightly active slot, measured. Budget 1 GB per active slot for real work
(exports, the browser client), which ticket 38 proves under load. Three active slots then need about 3 GB on the Windows side next to
SQL's shared 1.3 GB, well under the design's 2 GB-per-slot estimate. The slots run on Windows, not in WSL, so the WSL cap must leave
Windows that room.

**The cold-start time.** The first request of a brand-new slot (nothing compiled) took 12–15 s (12.0 s, 15.4 s and 12 s in spike 05). The
first request after a pool stop and start took 2.1–2.5 s, and warm requests took under 10 ms. The design's 13.7 s and 41.5 s were first
requests of long-idle installs. A reset slot is not brand-new (its compiled files stay in the ASP.NET temp folder; inferred, not checked), so
the 2.5 s case should apply.

**Recommendation for ticket 14: a background reset after `return` is enough, and `get` can always fall back to an inline reset.** At
about 10 s, a reset is shorter than most waits a worker already accepts. The background reset keeps `get` instant in the normal case. An
inline reset in `get` (no clean slot free, or a quarantined slot retried) adds about 10–15 s including the first request. Keep the
invariant that a slot is handed out only when its stamp, its database marker and the state file agree. Two cases need their own handling:
- A restore blocked by a foreign session: end it as admin and retry once, then quarantine.
- A cold file cache after a reboot: still unmeasured. If it makes the mirror slow, the reset is still correct, just slower.

VHDX or ReFS cloning (check 8) is not needed: the mirror is far under the 3-minute threshold.

## Other numbers from these runs

- Baseline install with a database: 465 s and 642 s (295 s in spike 05; the laptop was busier). Full tree copy for a clone: 28–36 s
  (13.5 s in spike 05). Restore for a clone: 1.6–1.8 s.
- One licence key served both slots again (spike 05's verdict holds after a rebuild).
- Teardown removed everything with a spike prefix (`leftover` all 0), and the pre-flight afterwards found the deny-listed installs
  unchanged (`denyListUnchangedSinceBaseline: true`).

## What the runs taught the scripts

- **60's error handling.** A .NET exception thrown from a method call reaches PowerShell's `catch` wrapped in a
  `MethodInvocationException`. Reading `.Number` from the wrapper ended the first run; 60 now looks for the `SqlException` in the inner
  chain.
- **The lock check.** A sample of 60 files per folder from the server `bin`, OAuth `App_Data` and the OAuth and Vault folder roots found
  nothing locked, because the OAuth DLLs live in `OAuthServer\Bin\`. 50 now tries every file.
- **Local user names.** Windows refuses local user names over 20 characters (`arashouse_spike_nonadmin`); the test user is now
  `arashouse_spike_na`.
- **robocopy `/XF`.** It needs the source-side path (above).
