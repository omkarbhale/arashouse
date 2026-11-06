# Operator runbook

For the captain, or firstmate, operating the pool on the laptop. A worker who only takes leases needs
`docs/using-a-lease.md`. Every option is in `docs/cli.md`; each section here points to the page that records the
command being run on the host.

Commands are run from WSL in an arashouse checkout after `npm ci && npm run build`, as `arashouse` (or
`node dist/cli/index.js`). A step marked **elevated** is a Windows PowerShell script the captain runs with Run as
administrator, or firstmate runs through its elevated gate. Every such script is a dry run without `-Apply`: run it
once without, read the plan, then with `-Apply`.

## Where things are

| what | where |
|---|---|
| the pool's state, events and config (WSL) | `~/.arashouse/` (`$ARASHOUSE_HOME`): `state.json`, `events.log`, `config.json`, `leases/` (one 0600 password file per lease), `logs/` (import and bootstrap logs), `recipes/` |
| the install root (Windows) | `C:\aras_installations\` (`/mnt/c/aras_installations` from WSL) |
| a slot | tree `slots\<flavor>\<NN>\`, vault `vaults\<flavor>-<NN>\`, IIS application `/ah-<flavor>-<NN>`, database `arashouse_<flavor>_<NN>`, agent service `ArasHouseAgent_<flavor>_<NN>` |
| a flavor's golden | `golden\<flavor>\` (tree, `ootb.bak`, the shipped backups, `manifest.json`, `flavor.json`) |
| the broker | service `ArasHouseBroker` (`NT SERVICE\ArasHouseBroker`), installed in `broker\`; `broker\setup-host.json` is the last setup run |
| the broker's audit log | `logs\broker-YYYYMMDD.log` (UTC day), one JSON line per request: time, verb, target, outcome, ms; never arguments. Readable elevated only (`docs/broker.md`) |
| the broker's service output | `logs\broker-service.log` (elevated only) |
| host-side secrets | `secrets\*.bin`, DPAPI, readable by the broker only (`docs/secrets.md`) |
| installers | the main checkout's `media/<flavor>/`, ignored by git (`media/README.md`) |

`arashouse status` is the pool at a glance; `arashouse doctor` checks all of it against the host. Start with those two
whatever the problem is.

## First-time setup

The order the pool was set up in on 2026-10-27 and 28. Each step names the page that records its run.

1. **The captain's sitting** (ticket 03). The captain's account is an administrator but workers run with a filtered
   token, so every elevated step below is the captain's or firstmate's gate. `sa` is not used: SQL setup runs under the
   captain's Windows login, a `sysadmin` (`docs/setup-sql.md`).
2. **Installers** (ticket 02). The CD image zips go in the main checkout's `media/12sp9/`, `media/23/`, `media/35/`.
   `arashouse media check` checks them (`docs/media-check.md`).
3. **Host setup** (ticket 21, `docs/setup.md`): folders, ACLs and the broker service.

   ```
   arashouse setup                                   # writes %TEMP%\arashouse-setup\
   powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle>\setup-host.ps1" -Apply      # elevated
   ```

4. **SQL setup** (ticket 22, `docs/setup-sql.md`): the broker's login and the `arashouse_admin` procedures. As the
   captain's Windows login; it needs `sysadmin`, not elevation.

   ```
   arashouse setup-sql                               # writes %TEMP%\arashouse-setup-sql\
   powershell -NoProfile -ExecutionPolicy Bypass -File "<dir>\setup-sql.ps1" -Apply -SelfTest
   ```

   `arashouse doctor` should now pass `setup`, `setup acl`, `broker`, `sql` and `sql login`.
5. **Licences** (ticket 34b, `docs/secrets.md`): one per line, `12` (for `12sp9`) and `14` (for `23` and `35`), read
   read-only from an existing install's config. Elevated:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\store-licence.ps1 -Line 12 -SourceConfig '<Program Files>\<install>\Innovator\InnovatorServerConfig.xml' -Apply
   ```

6. **Goldens** (tickets 24, 26, 27, 33b; `docs/baselines.md`), one per flavor, each a 5 to 15 minute elevated build:

   ```
   arashouse baseline build 12sp9 [--engine-check <built import-export-libs-js checkout>]
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\aras_installations\staging\baseline-12sp9\baseline-build.ps1" -Apply   # elevated
   arashouse baseline verify 12sp9
   ```

7. **The golden backup's `root` password** (`docs/health.md`), per flavor, so the health check can log in. Elevated:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\store-ootb-root.ps1 -Flavor 12sp9 -PasswordFile <the captain's DPAPI file> -Apply
   ```

8. **The pool** (ticket 37, `docs/pool.md`): `arashouse provision <flavor>` with no count makes `slots_per_flavor`
   (`12sp9` 3, `23` 2, `35` 2), about 40 s a slot plus its first health check.

   ```
   arashouse provision 12sp9 && arashouse provision 23 && arashouse provision 35
   arashouse doctor                                  # "every check passed"
   ```

Host-wide settings (a WSL memory cap, SQL `max server memory`, Defender, firewall, power) are not part of setup. They
are the operator's choice; `doctor` prints `advice` lines where one would help (`docs/host-tuning.md`).

## Add a flavor to the pool

For a flavor already in the registry (`arashouse flavors` lists it) that has no slots: put its media in `media/<flavor>/`,
then steps 5 to 8 above for it (its licence line if not yet stored, its golden, its `root` password, `provision`). That
is how `35` joined (`docs/baselines.md`, `docs/pool.md`). To change how many slots a flavor has, set
`slots_per_flavor` in `~/.arashouse/config.json` and run `arashouse provision <flavor>`, or give the count
(`arashouse provision 35 3`).

A new Aras release is code first: a registry entry in `src/core/flavors.ts` (release, server build, engine, licence
line, prerequisites), its config edit list in `src/core/edit-lists.ts`, and a spike of its install like
`docs/spike-08-release-35.md`, then the steps above. That is a ticket, not a runbook step.

## Rebuild a golden

When the installer changes, or a golden no longer verifies (`doctor`'s `baseline <flavor>` fails; `--deep` hashes every
file). Recorded in `docs/baselines.md` (`--replace`, and the `-Replace` rebuilds of tickets 24 and 33b):

```
arashouse baseline build <flavor> --replace       # marks the flavor's free slots dirty, writes the bundle
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\aras_installations\staging\baseline-<flavor>\baseline-build.ps1" -Apply -Replace   # elevated
arashouse baseline verify <flavor>
```

Leased slots are not touched; each is reset from the new golden when it is returned. A build that failed is cleaned up
with `baseline-build.ps1 -Cleanup` (elevated), which removes only its throw-away instance.

## A quarantined slot

A slot whose reset failed is `quarantined` and never handed out. `arashouse status` prints, below its table, one line per
quarantined slot with the reason (`quarantine_reason` in `status --json`). The one recorded on the host
(`docs/e2e-12sp9.md`, step 8):

```
quarantined 12sp9-01: reset step tree was refused: tree reset of 12sp9-01 failed at verify: ... 1 extra: extra Innovator/Client/arashouse-e2e-lock-<tag>.txt
```

There a process the last holder's server code had started held a new file open, so the tree reset could not delete it
and its verify found the file still there. None of the steps below needs `--yes` (a quarantined slot holds no lease) or
elevation (the broker does the work).

1. **Read the reason.** It names the step and, for the tree, the file. A file held open is released when its process
   ends (the e2e's ended after 150 s). From WSL you cannot see the process; you can only try step 2 again. On Windows,
   the elevated Resource Monitor (CPU, Associated Handles, search for the file name) shows it, and ending it frees the
   file; that has not been needed on the host.
2. **`arashouse repair <slot>`** resets it from golden in the foreground (46 s in the e2e): it ends `free` (exit 0),
   or `quarantined` again with exit 5 and the new reason. Try again once the process has ended.
3. **`arashouse repair <slot> --rebuild`** if the slot itself is damaged (its IIS application, database or folders):
   it destroys and re-provisions the slot, then resets it.
4. **Still quarantined:** `arashouse disable <slot>` takes it out of rotation and stops it while you look at the
   reason with `doctor`; `arashouse enable <slot>` puts it back through a reset. Or remove it and make it again:
   `arashouse destroy <slot> --yes`, then `arashouse provision <flavor>`, which makes the missing slots up to
   `slots_per_flavor` (that one, here).

`repair` refuses a slot that is not quarantined (exit 7, `23-02 is free, not quarantined`).

## A slot stuck `dirty` or `resetting`, or a lease left behind

- **`dirty` with nothing resetting it, or `resetting` under a worker that died**: `arashouse doctor --fix` starts a reset
  worker for each. `docs/e2e-12sp9.md` (step 7) and `docs/capacity.md` (the broker killed mid-reset) record it.
- **A holder that crashed or forgot its lease**: `status` shows its age, with `old` after 24 hours, and the
  `force-return` that would end it. Nothing reclaims a lease on its own (no expiry). Ask the holder first; then

  ```
  arashouse force-return <slot> --lease-id <the LEASE column> --yes
  ```

  It dirties and resets the slot like `return`. A lease id the slot no longer holds exits 4 and changes nothing.

## A lost or broken state file

`~/.arashouse/state.json` is rebuilt from the slot stamps on the host (ticket 11):

```
arashouse doctor --rebuild-state                  # says what the rebuilt state would hold; changes nothing
arashouse doctor --rebuild-state --yes            # sets the old file aside as state.json.corrupt-<time>, writes the new one
arashouse doctor --fix                            # resets the slots the rebuild left dirty
```

A slot whose stamp names a lease comes back `leased` to `unknown (recovered)`; every other slot comes back `dirty`, so
it is reset before it is handed out. A recovered lease's password file in `leases/` survives when only `state.json`
was lost; if the file is gone too, `run` on that lease exits 4: the holder returns it and takes a new one. The dry run
was run on the host (2026-10-28, 7 slots read back from their stamps); the `--yes` path is tested offline
(`src/core/recovery.test.ts`).

## The broker does not answer

Every host call exits 6, and `doctor` fails `broker: did not answer`.

1. The service restarts itself after a crash (after 5 s, 10 s and 60 s): `docs/capacity.md` records it back 6 and 11.5 s
   after its process tree was killed. Wait a minute and run `arashouse doctor` again.
2. Another lane may be updating it (`setup-host.ps1 -UpdateBroker` restarts it). `docs/pool.md` records a provision
   that lost the broker that way and a `doctor --fix` that finished it.
3. On Windows, `Get-Service ArasHouseBroker` (no elevation needed; it reads `Running`, `Automatic` when healthy) shows
   whether it runs; `logs\broker-service.log` (elevated) holds its output. `Start-Service ArasHouseBroker` (elevated)
   starts a stopped one; the restart recovery has always done that so far, so it has not been needed on the host.
4. Reinstall it from a fresh build: `arashouse setup`, then `setup-host.ps1 -Apply -UpdateBroker` (elevated). It
   recompiles the wrapper, checks every file against the hashes the bundle was generated with, and restarts the service.
5. Then `arashouse doctor --fix`: resets that lost the broker left their slots `dirty`, and it starts them again.

A broker outage loses no lease: leases live in WSL's state, and `run` still works once the broker is back.

WSL itself can fail to start `node.exe` on a busy host (`UtilAcceptVsock ... accept4 failed 110`); the CLI retries that,
and a call that still fails exits 6 with the broker untouched (`docs/broker.md`).

## The IIS configuration is not readable

Every reset, start, provision and deploy fails at its IIS step with

```
the IIS configuration is not readable: running as NT SERVICE\ArasHouseBroker; administrator token: no; applicationHost.config opens: no. the process has no administrator token; ...
```

and the slots that were being reset end `quarantined` (`reset step ... failed twice ...`). `ArasHouseBroker`, `W3SVC` and
`WAS` all read `Running`, `ping` answers, and it began at a restart or reboot: the broker needs an **administrator
token** to read IIS (a process without one reads the configuration as empty or gets an access error, which the message then quotes), and it no longer has one.
`arashouse doctor` fails `broker token: NT SERVICE\ArasHouseBroker runs without an administrator token ...`; the broker
reads its own token in its own process for this, so a membership that was put back but a service that was not
restarted is reported too. A broker that predates the check gives a `warn` (`-UpdateBroker`, `docs/setup.md`).

**Cause seen on the host (2026-11-06).** A domain Group Policy ("Restricted Groups", `Group Membership` in the
security template) sets the local Administrators group to exactly the domain's list, which removes any account added by
hand, the broker's virtual account `NT SERVICE\ArasHouseBroker` included (`setup-host.ps1` adds it at install,
`docs/setup.md`). The running broker keeps its old token until it restarts, so resets worked until the reboot and
then every one failed. Arashouse's code and tests cannot see the policy; this is the host's setting.

Diagnose from WSL or Windows, no elevation needed:

1. `arashouse doctor`: the `broker token` line.
2. `net localgroup Administrators` (Windows): `NT SERVICE\ArasHouseBroker` is missing from the list. `sc.exe showsid
   ArasHouseBroker` gives the service's SID (it depends on the service name only, so it is the same on any machine).
3. Elevated only, to learn when and by what: Event Viewer, Security log, events 4732 (member added) and 4733 (removed)
   for `Administrators`.

Put it back (**elevated**, in a Windows PowerShell; arashouse never changes a host group by itself, the same step
`setup-host.ps1` does at install):

```
net localgroup Administrators "NT SERVICE\ArasHouseBroker" /add
Restart-Service ArasHouseBroker      # a new token is only minted when the service starts
```

Then `arashouse doctor` (`broker token` ok) and `arashouse repair <slot>` for each quarantined slot (`A quarantined slot`
above), or `arashouse doctor --fix` for slots left `dirty`.

**It will be undone** at the next policy refresh and then show again at the next broker restart, because the policy owns the
group. Lasting fixes are not arashouse's to apply:

1. Ask IT to add the broker's service SID (from `sc.exe showsid`, step 2) to that policy's Administrators list. Cleanest.
2. Run the broker as `LocalSystem`, which Restricted Groups does not touch. A design change (service account, the broker's
   SQL login in `docs/setup-sql.md`, the ACLs in `docs/setup.md`), not a quick fix.
3. Repeat the step above after every reboot, whenever `doctor` fails the `broker token` check. Cheapest and fragile.

Follow-up, not built: a reset that fails for this host-wide reason still ends `quarantined` after two tries, so one
outage turns every returned slot into `repair` work. The reset could check the token first and leave the slot `dirty`
(retry later) with one host-level warning in `status`.

## Free disk

`doctor`'s `disk` check warns under `min_free_disk_gb` (10 GB); a provision or a baseline build will not start below it.
The pool is small (`docs/pool.md`, measured): a slot is 0.7 to 1.3 GB, the seven slots 6.3 GB, the goldens 2.7 GB, the
media 2.7 GB, about 12 GB in all. A reset brings a slot back to its size, so a slot grows only while it is leased.

- `arashouse disable <slot>` takes a slot out of rotation and stops it (RAM, not disk); `arashouse prune --yes`
  destroys every disabled slot and every orphan (a slot on the host with no record).
- `arashouse destroy <slot> --yes` removes one slot; `arashouse provision <flavor> <count>` with a lower count does
  not remove any, so lower `slots_per_flavor` and destroy the slots above it.
- `C:\aras_installations\staging\` holds the baseline bundles (`baseline-<flavor>\`, with their media: 384 to 561 MB
  each, about 1.4 GB on 2026-10-28). A bundle is not needed once its golden verifies, and `baseline build` writes a new
  one for the next build.

## Change `max_active` and the other limits

`~/.arashouse/config.json`, read by every command (no restart). Every key is optional; an unknown key is refused
(`docs/governor.md`):

```json
{ "max_active": 3, "max_resets": 2, "min_free_ram_mb": 2048, "min_free_disk_gb": 10, "slots_per_flavor": { "12sp9": 3, "23": 2, "35": 2 } }
```

`max_active` is leased slots at once across all flavors; lowering it below the leases held refuses new `get`s until
enough are returned, and takes nothing away. Ticket 38 confirmed 3 on this laptop (`docs/capacity.md`).
`min_free_ram_mb` is the free Windows RAM a `get` needs.

## Restarting WSL

`wsl --shutdown` ends every WSL session on the laptop, every worker and firstmate with them, so it is the captain's
sitting (ticket 44). It is needed, for example, to apply a WSL memory cap (`docs/host-tuning.md`). The broker, IIS and
SQL Server run on Windows and keep running; the pool's state is on WSL's disk and survives.

Before:

1. `arashouse status`: ask each holder to take out what they need and return; note any lease still held.
2. Wait until no slot is `resetting` (`status`): a reset worker runs in WSL and dies with it. A dead one is recovered,
   so this only saves a reset.

After:

1. `arashouse doctor`: the broker answers, and any slot left `resetting` shows as a dead worker.
2. `arashouse doctor --fix`: those slots go `dirty` and are reset.
3. A lease held across the restart is still held, with the same id and password file. Its holder's session ended, so
   return it (`force-return`) unless the holder will pick it up.

That recovery (a dead reset worker, the broker gone and back, a lease kept) is what `docs/capacity.md` and
`docs/e2e-12sp9.md` (step 7) exercise; a `wsl --shutdown` with the pool live has not been run.

## Logs and audit

| question | where |
|---|---|
| who leased, returned, reset what, and when | `~/.arashouse/events.log` (one JSON line per transition; lease ids as their first 8 characters) |
| why an import or a bootstrap step failed | `~/.arashouse/logs/<lease_id>-import-<n>.log`, `<lease_id>-bootstrap.log` |
| what the broker was asked to do | `C:\aras_installations\logs\broker-YYYYMMDD.log` (elevated) |
| why the broker stopped | `C:\aras_installations\logs\broker-service.log` (elevated) |
| how the host was set up | `C:\aras_installations\broker\setup-host.json` |
| why a slot is quarantined | `arashouse status` (`quarantine_reason` in `--json`) |

None of these holds a password: the e2e and audit checks grep them for every lease password (`docs/e2e-12sp9.md`).

## Uninstall

`arashouse teardown` (ticket 49, `docs/teardown.md`) removes every slot, then writes the elevated script that removes
the SQL objects, the broker and, if asked, the goldens and the root:

```
arashouse teardown [--goldens] [--remove-root]                                # the plan
arashouse teardown [--goldens] [--remove-root] --yes                          # destroys every slot, writes the script
powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle>\teardown.ps1" [-Goldens] [-RemoveRoot] -Apply   # elevated
```

It refuses while any slot is leased unless each is named with `--include-leased`, and it removes only names on the
allowlist; the captain's installs are fingerprinted before and after and must be unchanged. It never touches `media/`.
On this host `-RemoveRoot` refuses while the root also holds `gate\`, `instances\` and `spike\`. The dry runs were run on
the host; the full cycle is deferred to a quiet host (`docs/teardown.md`, "On the host").

## Never

- Never point a command at `OLM_Local`, olm, prod, `12sp9` (the database) or the captain's own installs: arashouse
  refuses them (exit 7), and nothing here needs them.
- Never type a password into a command line. Secrets go in at a hidden prompt or through the store scripts above.
- Never edit `state.json` by hand: use `doctor --fix`, `force-return`, `repair` or `doctor --rebuild-state`.
