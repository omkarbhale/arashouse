# Host setup: `arashouse setup`

Ticket 21. The one-time preparation of the Windows host, and the install of the broker (`docs/broker.md`).
Nothing here touches SQL Server objects or uses `sa` (ticket 22). Host memory, the WSL cap and the firewall are
ticket 44 (`docs/host-tuning.md`).

## Running it

1. From WSL, in the arashouse checkout, after `npm run build`:

   ```
   node dist/cli/index.js setup            # or `arashouse setup`; --out <dir> writes elsewhere
   ```

   It writes a bundle to `%TEMP%\arashouse-setup\` on Windows (`--out` takes a WSL path to another empty folder):
   `setup-host.ps1`, `package.json` and `app\` (a copy of `dist\`). It prints the two commands below.
2. The captain, in an **elevated** Windows PowerShell (Run as administrator):

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle>\setup-host.ps1"          # the plan: changes nothing
   powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle>\setup-host.ps1" -Apply   # makes the changes
   ```

3. From WSL: `arashouse doctor` (or `doctor --json`). The `setup`, `prerequisites`, `setup acl` and `broker` checks
   should pass. The `sql` check fails until `arashouse setup-sql` creates the broker's SQL login (ticket 22,
   `docs/setup-sql.md`).

`arashouse setup` must run as the worker user, the Windows user WSL interop runs as. It reads that user's name and
SID with `whoami.exe /user` and writes them into the script, so the ACLs name the user whose workers lease slots.

## What the script does

`setup-host.ps1` is generated from the constants the guards use (`src/core/names.ts`, `src/core/setup-host.ts`,
`src/core/flavors.ts`): every path in it is derived from the root `C:\aras_installations`. Windows PowerShell 5.1,
plain ASCII.

- **Dry run by default.** Without `-Apply` it prints each change as `would do:` and changes nothing; it needs no
  elevation, though some reads (the ACL of `secrets\`) do. With `-Apply` each change is printed as `do:` and then
  made. `-Apply` in a shell that is not elevated exits 4 before anything else.
- **Idempotent.** It compares the host with the plan and changes only what differs. A second run repairs an ACL
  that drifted and starts a stopped service, and nothing else.
- **Last, `result:` and the result as JSON**, also written (with `-Apply`) to `<root>\broker\setup-host.json`, where
  `arashouse doctor` reads it from WSL. The JSON holds names and SIDs, no secret.
- **Exit codes:** 0 ok; 1 a step failed, or after `-Apply` the result is not ok; 2 refused arguments; 4 not
  elevated.

The steps, in order:

1. **Folders.** Creates `C:\aras_installations` (if missing) and `golden\`, `slots\`, `vaults\`, `sqldata\`,
   `staging\`, `logs\`, `secrets\`, `golden-build\` and `broker\`. A folder that is a junction or symbolic link is
   refused.
2. **The root's own ACL.** The root inherits from `C:\` the right of every authenticated user to modify it, so any
   user could rename the root away and put a new one, holding a new service binary, in its place. The script takes
   delete, rename and re-permission rights on the root folder itself from everyone but SYSTEM and Administrators.
   What the root passes down to its children is unchanged, so other folders under the root (on this host:
   `gate\`, `instances\`, `spike\`, which are not arashouse's) keep exactly the access they have.
3. **Folder ACLs.** Each folder gets a whole, protected DACL (nothing inherited from the root), applied to the
   folder, its subfolders and files:

   | folder | SYSTEM | Administrators | `NT SERVICE\ArasHouseBroker` | worker user | SQL Server account |
   |---|---|---|---|---|---|
   | `golden\` | full | full | modify | | read |
   | `slots\` | full | full | modify | **read** (to take code out, ticket 43) | |
   | `vaults\` | full | full | modify | | |
   | `sqldata\` | full | full | modify | | modify |
   | `staging\` | full | full | modify | **modify** | read |
   | `logs\` | full | full | modify | | |
   | `secrets\` | full | | modify | | |
   | `golden-build\` | full | full | modify | | |
   | `broker\` | full | full | modify | **read** (the client and its token) | |

   The SQL Server account is read from the `MSSQLSERVER` service definition, not assumed (on this host
   `NT Service\MSSQLSERVER`). If there is no such service, its grants are left out and the run reports an error.
   When two principals share a SID (a SQL Server running as LocalSystem is SYSTEM), the folder grants that SID
   the union of their rights once, so a re-run finds no deviation.
   Ticket 25 adds each slot's app-pool identities inside `slots\` and `vaults\` when it provisions a slot.
4. **Prerequisites.** For each flavor with media in `media/` (every flavor if none can be told), it checks what
   `hostPrerequisites` in `src/core/flavors.ts` names and prints a `missing:` line for each one absent. It installs
   nothing.

   | prerequisite | flavors | checked by |
   |---|---|---|
   | IIS 10 with W3SVC, StaticContent, DefaultDocument, HttpErrors, RequestFiltering, ASPNET45, NetFxExtensibility45, ISAPIExtensions, ISAPIFilter | all | `HKLM\SOFTWARE\Microsoft\InetStp` |
   | .NET Framework 4.7.2 or newer | all | `NDP\v4\Full` `Release` |
   | ASP.NET Core 2.1 runtime, ASP.NET Core Module (V1) | `12sp9` | `dotnet\shared\Microsoft.AspNetCore.App\2.1.*`, the module's registry key |
   | ASP.NET Core 6.0 runtime, ASP.NET Core Module V2 | `23` | likewise |
   | ASP.NET Core 8.0 runtime, ASP.NET Core Module V2, Visual C++ 2015-2022 x64 | `35` | likewise, and `VC\Runtimes\x64` |

5. **The broker.** It finds `node.exe` (on `PATH`, else the default install) and refuses one older than Node 20,
   or one that a non-administrator could change (the file or its folder), since the service runs it as a local
   administrator. Then:
   - copies `app\` to `<root>\broker\app\` and `package.json` to `<root>\broker\`, and checks every file against
     the SHA-256 the script was generated with: a bundle changed after the script was reviewed is not started;
   - compiles the service wrapper `<root>\broker\ArasHouseBroker.exe` (C#, with Windows PowerShell's own
     compiler), which runs `node.exe <root>\broker\app\broker\index.js`, appends its output to
     `<root>\logs\broker-service.log`, and exits 1 when Node exits on its own;
   - creates the service `ArasHouseBroker` (automatic start) as the virtual account `NT SERVICE\ArasHouseBroker`,
     sets its recovery to restart after 5 s, 10 s and 60 s, adds the account to the local Administrators group
     (it creates IIS applications, pools and services; ticket 03), and starts it;
   - pings it through the same client a worker uses (`node.exe <root>\broker\app\broker\client.js`).

   An installed broker is left as it is on a second run. `-UpdateBroker` installs the bundle's build over it,
   recompiles the wrapper and restarts the service: the way a later ticket ships new verbs.
6. **Options, off by default.**
   - `-DefenderExclusion` adds a Defender exclusion for the root. The spike measured a reset at about 10 s with
     Defender on, so speed does not need it (map Q9).
   - `-SlotIdleTimeoutMinutes <1..1440>` records a short idle timeout for slot app pools in the result's
     `options`. No pool exists yet: ticket 25 applies it when it creates them. It is kept across runs.

## Installed on the host (2026-10-27)

The captain's elevated `-Apply` of the script generated from this branch exited 0 with `"ok": true` and no
errors: the root's own ACL tightened, the eight new folders created and `staging\` re-permissioned, every
folder's ACL as planned, no prerequisite missing for `12sp9`, `23` or `35`, and `ArasHouseBroker` running as
`NT SERVICE\ArasHouseBroker`, a member of Administrators, with restart recovery, answering `ping`. Read back from
WSL as the worker:

- `arashouse doctor --json`: `setup`, `prerequisites`, `setup acl`, `broker` (`arashouse-broker 0.0.0`), `disk`
  and `ram` ok. `sql` failed until ticket 22 created the broker's login (`docs/setup-sql.md`); the baselines warn until ticket 28 adds
  `baselineVerify`.
- `ls /mnt/c/aras_installations/secrets`: `Permission denied`.
- `ping` through `node.exe <root>\broker\app\broker\client.js` from WSL: about 0.27 s.

## Uninstall

`setup-host.ps1 -Uninstall -Apply` stops the service, takes its account out of Administrators, deletes the
service and removes the Defender exclusion if there is one. `-RemoveRoot` also deletes the root, but only when it
holds nothing but the arashouse folders above and no junction or link; otherwise it refuses and deletes nothing.
On this host the root also holds `gate\`, `instances\` and `spike\`, so `-RemoveRoot` refuses until they are gone.
Ticket 49 (`arashouse teardown`) removes the slots, IIS objects and SQL objects first.

## What it never does

It writes nothing under Program Files (it reads `node.exe` and the ASP.NET Core runtimes there through
`$env:ProgramFiles`), touches no SQL Server object, installs no prerequisite, does not change what the root passes
to folders that are not arashouse's, and reads or writes no secret. The tests (`src/core/setup-host.test.ts`)
check the script text: every change is inside an `Invoke-Change` block, which only prints without `-Apply`; no
path outside the root; no Program Files path. `test/setup-host.test.ts` runs it under Windows PowerShell when
one is reachable (a dry run, the refusals, `-Uninstall -RemoveRoot` leaving a folder that is not arashouse's,
the folder ACLs set and read back on a scratch root, and the wrapper compiling).
