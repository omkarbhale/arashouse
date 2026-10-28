# Audit: the guards, the secrets and the broker

Ticket 50. An adversarial audit by a worker that did not write the code. The goal is the one the captain cares about:
**nothing in the tool can reach `OLM_Local`, olm, prod or the captain's existing installs, and no secret is printed or
stored where it should not be.** Run on 2026-10-28 against `main` at `f6791df`, with the pool as ticket 37 left it
(`12sp9` x3, `23` x2, `35` x2). `12sp9-01` was leased to another task throughout, and the audit did not touch it.

Each check is recorded as pass or fail, with its evidence. A failure is fixed in this change, or it has a new ticket, or
it is put to the captain as an exception (at the end).

## How it was attacked

| Where | What | Run as |
|---|---|---|
| `test/audit.test.ts` (part of `npm test`) | every broker verb, every guard and every bootstrap input, against the names and paths below; each refusal is checked to come before anything on the host changes (the in-memory slot system's files and objects are hashed before and after) | offline |
| `test/host/audit-probe.ps1` | the pipe's DACL and four requests the broker must refuse, the folders' ACLs, what the broker listens on, port 80 and the firewall, PowerShell and Windows Installer logging policy | the worker, not elevated |
| `test/host/audit-sql.ps1` | the broker's login and every slot login, through `EXECUTE AS LOGIN`: roles, server rights, which databases they can open or own, `RESTORE`, `xp_cmdshell`, linked servers, `OPENROWSET`, and the `arashouse_admin` procedures with foreign and deny-shaped names | the worker, not elevated (the captain's login, `SG\omkarb`, is a `sysadmin`) |
| `test/host/login-check.ps1 -User <user>` | each shipped Aras user against each free slot, with the golden backup's shipped password | the worker, not elevated |
| `test/host/audit-secrets.ps1` | every process command line during a `get`, and the files, logs and event logs a secret could reach | elevated, through firstmate's gate |

The SQL checks never name the captain's databases. "Can the broker restore over `OLM_Local`?" is asked of
`arashouse_35_98`, a throw-away database the script makes, owned by the caller and not by the broker, so it stands for
any database the broker does not own. The script refuses to start if that name exists, and it drops the database at the
end. Questions about the rest of the server are asked as counts filtered by owner or by access, so no name is listed.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Name guards | **pass** after two fixes (F1, F2) |
| 2 | SQL from the pool login | **pass** |
| 3 | Broker: pipe ACL, size, malformed JSON, unknown verbs, stamp disagreement | **pass** (exception E3 on who holds the token) |
| 4 | Secrets | **pass**: in the repo, on command lines, in logs, event logs, staging and the WSL state, no secret outside the places designed for it (exception E8) |
| 5 | Bootstrap inputs | **pass** after F1 (exception E5: no size cap on a deploy) |
| 6 | Network | **fail, accepted by ticket 44**: slots answer on the LAN (exception E1) |
| 7 | Defaults: no OOTB login on a free slot | **fail**: `authadmin` logs in with the shipped password on every flavor (proposed ticket 57) |

### 1. Name guards

Every verb the broker serves, plus a list of verbs it does not have (`runCommand`, `exec`, `sql`, `__proto__`,
`constructor`, `toString`, `PING`, `ping `), was sent each of these as its slot or flavor:

- deny-listed names (`OLM_Local`, `olm`, `prod`, `InnovatorSolutions`);
- case and padding variants (`12SP9`, `12sp9 `, `12sp9.`);
- look-alikes: Cyrillic `О`, `М` and `ѕ`, fullwidth `ＯＬＭ` and `１２`, a zero-width space, and a Unicode hyphen in `ah‐12sp9‐01`;
- `..`, `..\12sp9`, `\\?\C:`;
- slot numbers 0, 100, -1, 1.5, 1e9, `"01"`, `null` and `true`;
- an extra field in the slot record (`database: "OLM_Local"`);
- the slot id as a string.

Every request was refused (`Refused`, before the verb), and the host was unchanged. The audit log records only the
validated fields, so a refused name never reaches it (`target: null`).

The guard was also attacked directly:

- **Names.** Each deny-listed name in upper, lower and original case, with a trailing dot and with a leading or trailing
  space, under every kind (database, alias, app pool, service, login), with and without a slot record. Look-alikes, and
  the tool's own names differing only in case (`ARASHOUSE_12SP9_01`, `AH-12SP9-01`, `arashouseagent_12sp9_01`), are
  refused too: the allowlists are lower-case ASCII, the form names are derived in.
- **Paths.** `\\?\` and `\\.\` device paths, `\\?\GLOBALROOT\...` and `\\?\UNC\...`, UNC paths with either slash, WSL and
  relative paths, a drive-relative `C:aras_installations`, `..` that climbs to `C:\Aras12`, a trailing dot or space on any
  segment, 8.3 names (`C:\ARAS_I~1`, `C:\PROGRA~2\Aras12`), alternate data streams (`::$DATA`, `:stream`), device names
  (`CON`, `nul.txt`), a NUL character, `D:` instead of `C:`, `Program Files (x86)\Aras*` in any case, `C:\Aras*`, and
  `OLM_Local` (fullwidth too) inside a slot. All refused.
- A path whose letters differ only in case (`slots\12SP9\01`) is accepted: Windows names the same folder, and the guard
  returns the canonical form.
- **Links.** A path with a junction at any level from the root down is refused, and so is a root whose real path is the
  captain's (`C:\Program Files (x86)\Aras12\Innovator`, `C:\Aras12`).
- **Path arguments.** Nine attack paths were given to `restoreDatabase` (`file`), `backupDatabase` (`path`),
  `resetDatabase` (`file`) and `deployCode` (`staged`), and six to `deployCode`'s `subpath`: a captain's install, the
  golden's `ootb.bak` (except for `resetDatabase`, whose one legal file it is), `..` out of staging, the `\\?\` and UNC
  forms, another lease's folder, an 8.3 name, a trailing dot, and `OLM_Local.bak`. Each was refused by the path guard
  itself, not by a later step, and nothing on the host changed. An argument a verb does not take (`database`, `command`,
  `sql`, `path`) is refused.

**F2, fixed here.** The map's deny-list (map notes; `AGENTS.md` rule 2) names `InnovatorSolutions*` and `InnovatorServer*`,
but the guard matched only the exact names `InnovatorSolutions`, `InnovatorSolutions28`, `InnovatorServer` and
`InnovatorServer23`. This mattered in one place: a backup recorded under a name such as `InnovatorSolutions23` passed the
restore's foreign-origin check (ticket 39, `docs/restore.md`). The allowlists already refused such names everywhere else.
`nameDenial` now matches those prefixes (`DENIED_NAME_PREFIXES` in `src/core/guards.ts`). It also folds compatibility forms
(NFKC) before comparing, so `ＯＬＭ_Local` is `OLM_Local`. Cyrillic and Greek look-alikes are not folded; see E7.

**Also fixed.** A stamp of another flavor was refused with the message "the stamp names 12sp9-01, not 12sp9-01". It now
says "the stamp's flavor is 23, not 12sp9".

### 2. SQL from the pool login

Run `test/host/audit-sql.ps1` (149 checks, exit 0); the output was kept outside the repo. Every result below is as the
broker's login `NT SERVICE\ArasHouseBroker`, unless a line says otherwise.

- **Roles.** It is in no server role: not sysadmin, securityadmin, serveradmin, setupadmin, processadmin, diskadmin,
  dbcreator or bulkadmin.
- **Server rights.** It holds none of these: `CONTROL SERVER`, `CREATE ANY DATABASE`, `ALTER ANY DATABASE`, `ALTER ANY LOGIN`, `ALTER ANY
  LINKED SERVER`, `ALTER ANY CONNECTION`, `ADMINISTER BULK OPERATIONS`, `IMPERSONATE ANY LOGIN`, `CONNECT ANY DATABASE`,
  `ALTER SETTINGS`, `ALTER ANY CREDENTIAL`, `EXTERNAL ACCESS ASSEMBLY`, `UNSAFE ASSEMBLY`, `VIEW SERVER STATE`, `ALTER SERVER
  STATE`.
- **Reach.** It can open 0 databases outside `arashouse_*` (`HAS_DBACCESS`), owns 0, and cannot open `arashouse_35_98`.
- **Writes to a database it does not own.** On `arashouse_35_98`: `RESTORE ... WITH REPLACE` was refused with 3110 (no
  permission). `ALTER DATABASE ... SET OFFLINE` was refused (5011), as were `DROP DATABASE` (3701) and `BACKUP DATABASE`
  (916). A `RESTORE` of a made-up name outside `arashouse_*` was refused with 262 (no `CREATE DATABASE`).
- **The procedures, on a database it does not own.** `create_slot_database`, `drop_slot_database`, `kill_connections`
  and `adopt_slot_database` on `arashouse_35_98` (a slot-shaped name the broker does not own) were each refused with
  50002.
- **The procedures, on deny-shaped names.** Each was called, and so was `drop_slot_login`, with ten made-up names:
  `OLM_Local_audit_madeup`, `olm`, `arashouse_olm_01`, `InnovatorSolutions_audit_madeup`, a `; DROP DATABASE` injection, a
  fullwidth digit, a Cyrillic letter, upper case, a trailing dot, and a bracketed name. All 50 calls were refused with
  50001.
- **`read_staged_backup`.** It refused six paths with 50001: a folder outside the root, UNC, `\\?\`, `..`, an 8.3 name, and
  a lower-case drive letter.
  (Ticket 22's own negative test, `setup-sql.ps1`, repeated on 2026-10-27, covers 84 more names; `docs/setup-sql.md`.)
- **`xp_cmdshell`, linked servers and ad hoc queries.**
  - `xp_cmdshell` and `Ad Hoc Distributed Queries` are both off on the server.
  - The broker running `xp_cmdshell` was refused (229), adding a linked server was refused (15247), and `OPENROWSET` was
    refused (15281).
  - It can use 0 linked servers.
  - `public` holds nothing beyond `VIEW ANY DATABASE` and endpoint `CONNECT`.
- **Every slot login** (16; the two of `12sp9-01` left alone) is in no server role, holds none of `CONTROL SERVER`,
  `CONNECT ANY DATABASE`, `ALTER ANY LINKED SERVER`, `ADMINISTER BULK OPERATIONS` or `CREATE ANY DATABASE`, and opens no
  database but its slot's. So SQL that a leaseholder's package runs as the slot's `dbo` cannot reach another database.
- **Windows logins.** SQL Server's only Windows logins are `NT AUTHORITY\SYSTEM`, `SG\omkarb` and the `NT SERVICE`
  accounts: no group such as `BUILTIN\Users` and no `IIS APPPOOL\*` login. So a slot's pool identity cannot reach SQL by
  Windows authentication.
- **Logins the tool did not create.** `arashouse_pp_23_*` and `arashouse_pp_35_*` were seen. They are the host's own,
  outside the pool's derived names, and are already known (`docs/teardown.md`, `docs/provision.md`). The tool neither
  names nor drops them.

### 3. The broker

Measured by `audit-probe.ps1` on the host:

- **The pipe's DACL** is `(A;;0x12019f;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)`: Everyone may read and write, as
  `docs/broker.md` says Node forces. So the token is the gate.
- **Four requests sent on the pipe.**

  | request | answer |
  |---|---|
  | no token | `Refused`: "the request does not carry the broker's token" |
  | a wrong 64-character token | `Refused`: "the request does not carry the broker's token" |
  | a 70 KiB line | `Refused`: "the request is larger than 65536 bytes" |
  | `{not json` | `Refused`: "the request is not JSON" |

- **The token file** `broker\client.token` inherits `broker\`'s ACL: SYSTEM and Administrators full, the worker user
  (`SG\omkarb`) read, and the broker's account modify. `logs\`, `secrets\`, `sqldata\` and `golden\` are not readable by
  the worker; `staging\` is.
- **Who can call it.** Another local user, or a process in another logon session of another user, can open the pipe but
  cannot read the token, so every request it sends is refused as above. A process of the worker user in any session can
  read the token; that is the design (E3).
- **The broker listens on no port**: 0 TCP and 0 UDP endpoints for `ArasHouseBroker.exe`, its `node.exe` and `conhost.exe`.
- **Verbs, request shape, stamps.** Offline (`test/audit.test.ts`), the broker serves exactly the host-driver methods
  except `baselineBuild` (which it refuses), plus `storeLicence` and `storeOotbRoot`. Any other verb, field or argument
  is refused. `writeStamp` refuses a stamp naming another slot, flavor or a malformed id. `deployCode`, `backupDatabase`
  and `restoreDatabase` refuse a lease the slot's stamp does not name.

### 4. Secrets

**The repo.**

- Every tracked file and the whole history (`git log --all -p`) were searched for credential shapes: a private key, a
  quoted password, `Password=`, `-P`, the MD5 of Aras's shipped password, and a `lic_key` or `act_key` with a value.
- Found only placeholders (`LICENCE-KEY-PLACEHOLDER-*`, template variables) and the Aras MSI's public default
  `innovator` in one test fixture (`src/broker/baseline-build.test.ts`).
- No installer, backup, `.pfx`, `.cer`, `.dpapi`, `.bin` or key file is tracked (`test/tracked-files.test.ts` also
  enforces this).
- The history was also handed, as text, to the elevated search below, which looks for the real licence in it.

**How secrets travel (static).**

- Every child process gets its secret on stdin, never in its arguments:
  - the broker's client: the request line;
  - the PowerShell steps: a JSON request (`ps-step.ts`, `slot-steps.ts`, `baseline-steps.ts`);
  - `aras-pkg`: `--password-stdin`;
  - the signing certificate's password, on the step's stdin.
- `setup-sql.ps1` makes its certificate password itself and gives it to SQL Server only as a parameter.
- The baseline build's MSI install passes no secret property (Windows authentication, no `LICENSEKEY`). It sets
  `MsiHiddenProperties` and deletes its log after reading the failed actions. That is ticket 04's MSI-log rule.

**On the host (measured).**

- PowerShell transcription, script-block and module logging policies are all unset, and so is Windows Installer's
  logging policy.
- One thing was found that makes the static rule matter: the classic **Windows PowerShell** event log records the full
  command line of every `powershell.exe` start, for as long as the log keeps it. A dry run of the search script
  deliberately started one process with a made-up test value on its command line: the script found that value in the
  command lines it recorded, and 8 times in that event log. A secret on a PowerShell command line would therefore stay
  in a log readable by any administrator. The search below reads that log as far back as it goes, so it also covers the
  captain's earlier setup sittings, which ran before this audit and could not be watched live.

**The elevated search during a real `get`.**

Firstmate's gate ran `test/host/audit-secrets.ps1` elevated (exit 0; SHA-256 `8FD6030D...1008`). Its monitor watched
from 19:56:53 for 96 s, while the worker ran
`arashouse get 23 --holder audit-50 --json --password-fd 3`. The descriptor fed a WSL process that never printed the
password: it counted the password in `~/.arashouse`, then sealed it for the monitor.

It saw 408 processes and recorded 300 distinct command lines: the CLI's `node.exe` client, the broker's `node.exe`, every
PowerShell step of the reset, health check and lease credentials, and IIS's worker processes. In each place below it
counted the lease's password, the password's MD5 hex (what an Aras client sends in its place, upper and lower case), and
the broker's token, both as written and decoded from any `-EncodedCommand` payload:

| place | files or events | lease password | its MD5 | broker token |
|---|---|---|---|---|
| command lines during the `get` | 300 | 0 | 0 | 0 |
| `logs\` (the broker's audit and service logs) | 3 files | 0 | 0 | 0 |
| `staging\` (every lease's folder, and the repo's whole history as text) | 956 | 0 | 0 | 0 |
| `broker\` (not `app\` or the token file) | 4 | 0 | 0 | 0 |
| `golden\` (text files) | 4304 | 0 | 0 | 0 |
| the leased slot `23-01` (its text files) | 1942 | 0 | 0 | 0 |
| Windows Installer logs | 1 | 0 | 0 | 0 |
| PowerShell console histories, transcripts | 2, 0 | 0 | 0 | 0 |
| `~/.arashouse` | 35 | **1**: `leases/<lease_id>`, by design | 0 | 0 |
| event logs Application, System | 30000 each | 0 | 0 | 0 |
| event logs Windows PowerShell, PowerShell Operational | 11596, 1477 | 0 | 0 | 0 |
| event log Security (4688, process creation) | 30000 | 0 | 0 | 0 |

The worker's own count of `~/.arashouse` and the `get` JSON agrees: the password is in `leases/<lease_id>` only. That is the
WSL side's one persisted secret (`docs/secrets.md`): mode 0600 in a 0700 folder, so that `run --lease` can hand it on, and
deleted by `return`: after `arashouse return`, `leases/` held only the other task's lease file. `get --json` with `--password-fd` printed no `password` field. The sealed file was
deleted by the script.

**The licence.** The elevated run could not read the stored licences: `secrets\` is readable only by SYSTEM and the
broker, not by Administrators, which is itself the protection `docs/secrets.md` describes. So the licence was searched
from where every slot of its line legitimately holds it. Run by the worker, not elevated, in memory, printing counts
only, it took line 14's `lic_key` and `act_key` from `slots\23\01\InnovatorServerConfig.xml` and found them:

| place | files or events | licence |
|---|---|---|
| every slot's `InnovatorServerConfig.xml` | 7 | 8: two values in each of `23-01`, `23-02`, `35-01` and `35-02`, the slots of line 14, where the edit list renders it |
| every other config, XML, JSON, log and text file of `23-01` | 26388 | 0 |
| `staging\` (with the repo's whole history as text) | 959 | 0 |
| `~/.arashouse` | 35 | 0 |
| PowerShell console histories, Windows Installer logs | 2, 1 | 0 |
| event logs Application, System, Windows PowerShell, PowerShell Operational | 30000, 30000, 11604, 1480 | 0 |

Line 12's licence travels the same way (`storeLicence` on the client's stdin, rendered by the edit list), and no line-14
value was found outside the slots' configs.

### 5. Bootstrap inputs

- **`..`, absolute paths and junctions.**
  - Offline, a code deploy refuses each of: `../InnovatorServerConfig.xml`, `Server/../../x`, `C:/x`, a `\\?\` path, an
    8.3 name, a trailing dot, and any target outside `Innovator\` (or `VaultServer\` and `OAuthServer\` with
    `--allow-servers`; never `AgentService\`).
  - The broker refuses a link or junction anywhere in a staged tree; `src/broker/code-deploy.test.ts` covers that, and
    ticket 40 proved it on the host (`docs/code-deploy.md`).
  - A recipe's own paths are the leaseholder's files on WSL, read with the worker's own rights; what crosses to Windows is
    checked again in `staging\` by the broker.
- **A config overwrite.**
  - **F1, fixed here.** A deploy needed `--allow-config` only for `InnovatorServerConfig.xml`, `*.pfx`, `*.cer`,
    `key-*.xml` and `vault.config`.
  - It could replace `Innovator/Server/Innovator.xml` and `Innovator/Client/Innovator.xml` with no flag at all, and
    `OAuthServer/OAuth.config` and `OAuthServer/OAuthServer.config` with `--allow-servers` alone.
  - `Innovator.xml`'s `ConfigFilePath` decides which `InnovatorServerConfig.xml`, and so which database and logins, the
    slot's server uses. A code tree copied from one of the captain's installs carries that install's `Innovator.xml`,
    which names that install's config. A deploy of it would point the slot at the captain's database, with the captain's
    install's own credentials.
  - Every file any flavor's edit list renders now needs `--allow-config` (`isProtectedFile` in `src/core/code-deploy.ts`;
    `docs/code-deploy.md`). E2 covers what a leaseholder's own server code can still do.
- **A huge file.**
  - Bounded: a recipe at 1 MiB, a `deploy.json` at 1 MiB, a staged tree at 200,000 entries, and a broker request at 64 KiB.
  - A restore refuses a backup that needs more room than is free.
  - A code deploy has no byte limit, and the disk gate (`min_free_disk_gb`) runs only before a provision or a build (E5).
- **A backup recorded under a deny-listed database name** (ticket 39). `OLM_Local`, `olm_local_copy`,
  `InnovatorSolutions23` (refused since F2), `ＯＬＭ_Local` and `PROD` are refused unless `--allow-foreign-origin` is given.
- **A package whose items target other databases.**
  - `get --import` passes libs-js only the lease's own URL and database.
  - A recipe's import section has no `url` or `database` key, and a recipe that gives one is refused.
  - The SQL a package's items run executes as the slot's `dbo`, which opens no other database (check 2).

### 6. Network

| listener | address | who can reach it |
|---|---|---|
| port 80 (`http.sys`, IIS) | `::`, every interface | a slot answered `HTTP 200` on the WSL address 172.19.0.1 and on the Wi-Fi address 192.168.20.87; IIS's own rule `IIS-WebServerRole-HTTP-In-TCP` allows inbound TCP 80 from any address on every profile |
| the broker | none | nothing |

This is ticket 44's decision: the captain accepted "Firewall: inbound port 80 from the WSL range only" as **off**
(`docs/host-tuning.md`), because it would cut LAN access to every IIS site, the captain's own included. Ticket 44 took
that decision on the premise that "an idle slot has a random, unknown password". Check 7 shows that premise holds for
`root` and `admin` only.

### 7. Defaults

`test/host/login-check.ps1` tried one OAuth password grant per user, with the golden backup's shipped password, on every
free slot (`12sp9-02`, `-03`, `23-01`, `-02`, `35-01`, `-02`):

- `root` and `admin`: refused on all six ("Authentication failed").
- **`authadmin` logs in** on `12sp9-02`, `23-01` and `35-01`.
- `vadmin`, `clientadmin` and `JobAgentUser`: refused with this password.

Comparing the stored password hashes of two free slots of each flavor (equality only; no hash was printed) shows why:

- `root` and `admin` differ from slot to slot, because the reset re-keys them.
- `authadmin` and `vadmin` (all flavors), and `clientadmin` and `JobAgentUser` (`35`), are the same on every slot: the
  golden's shipped credentials, the same on every Aras install from that CD. They are logon-enabled.

**Fail.** A free or leased slot can be logged into as `authadmin` with Aras's well-known default, from anywhere on the
LAN (check 6). The fix belongs in the reset: re-key, or disable, every shipped user that can log in. It needs a host proof
on each flavor that the agent, the vault and OAuth still work, so it is proposed as a ticket of its own (57) rather than
made here.

## Exceptions for the captain

| # | What | Why it is not fixed in the tool |
|---|---|---|
| E1 | Slots answer on every interface on port 80, LAN included (check 6) | Ticket 44: narrowing the firewall would change a host-wide setting and cut LAN access to the captain's own IIS sites; the captain kept it off. With ticket 57, no shipped credential is left |
| E2 | A leaseholder's server code (an Aras Method, a DLL in a deploy) runs as the slot's pool identity, which may write its own slot's tree (`docs/e2e-12sp9.md`) and read whatever `BUILTIN\Users` may read. So the leaseholder's code could rewrite its own `Innovator.xml`, which F1 only stops a deploy from doing, or read another install's `InnovatorServerConfig.xml`, which holds that install's SQL credentials, if the install's ACL lets `Users` read it | Running a leaseholder's code is what a lease is for. Narrowing what `Users` may read in the captain's installs would change them (rule 2), so the audit did not read their ACLs either. The pool identity has no SQL login (check 2), so only credentials read from such a file could reach the captain's databases |
| E3 | Any process of the worker user (`SG\omkarb`), in any session (every WSL worker, the captain's own shell), can read the broker's token and call every verb | It is the design (`docs/broker.md`): the workers are that user. Another user cannot (check 3) |
| E4 | The worker user's SQL login `SG\omkarb` is a `sysadmin` without elevation, so any process of that user can reach every database directly, `OLM_Local` included, without arashouse | It is the captain's own SQL configuration, outside the tool. arashouse never uses it except in `setup-sql.ps1` and this audit's SQL script |
| E5 | A code deploy has no byte limit, so a leaseholder could fill the disk | Disk exhaustion only, no reach; the reset frees it. A per-deploy cap could be added with ticket 57 or later |
| E6 | The captain's earlier `setup` sittings were not watched live | Their command lines are covered by the Windows PowerShell event log, which check 4 searches |
| E7 | A Cyrillic or Greek look-alike of `OLM` in a backup's recorded database name passes the restore's foreign-origin check | The recorded name is a label set by whoever took the backup; renaming the database before the backup defeats the check just as well, so it guards against accidents, not intent. Every name the tool acts on is ASCII-allowlisted |
| E8 | The worker user may read every slot's tree (`slots\` grants it read), so it can read each slot's `InnovatorServerConfig.xml`, with the licence of its line and the slot's two SQL login passwords, its leased slot's and the others' | Aras reads the licence and the logins from that file, and a leaseholder needs to read its slot's tree; the SQL logins reach only their own slot's database (check 2). The licence store itself (`secrets\`) is readable only by SYSTEM and the broker, not even by an elevated administrator (check 4) |
