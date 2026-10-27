# Teardown: `arashouse teardown`

Ticket 49. Removes the whole pool, the broker and the SQL objects, as safely as one slot's reset. It is for when the
captain wants everything gone. It is a dry run by default, and it removes only names that match the allowlist.

## Running it

1. From WSL, in the arashouse checkout, after `npm run build`:

   ```
   node dist/cli/index.js teardown [--goldens] [--keep-sql] [--remove-root]          # the plan: changes nothing
   node dist/cli/index.js teardown [--goldens] [--keep-sql] [--remove-root] --yes    # destroys every slot, writes the script
   ```

   With `--yes` it first writes the bundle to `%TEMP%\arashouse-teardown\` on Windows (`--out` takes a WSL path to
   another folder): `teardown.ps1`, `host\` (the setup bundle; teardown runs only its `-Uninstall`) and
   `sql\setup-sql.ps1`. Then it destroys every slot through the broker, as `destroy` does one, and prints the two
   commands below with the switches the options map to (`-Goldens`, `-KeepSql`, `-RemoveRoot`).
2. The captain, in an **elevated** Windows PowerShell (Run as administrator):

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle>\teardown.ps1" [-Goldens] [-KeepSql] [-RemoveRoot]          # the plan
   powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle>\teardown.ps1" [-Goldens] [-KeepSql] [-RemoveRoot] -Apply   # make the changes
   ```

The disposability rule holds here as everywhere: whoever holds a lease takes out what they need first. Teardown keeps
nothing.

## The WSL half (`src/core/teardown.ts`)

- **Every slot**: those the state holds, and the orphans the host lists (`listSlots`), so a slot another state home
  made is found too. Each goes through `destroyOne`, the same code as `destroy`, so the record is removed first and
  the host's `destroySlot` removes exactly what the slot's names derive.
- **Refusals, before anything is destroyed.** A leased slot (by its record, or an orphan whose stamp names a lease)
  is refused (exit 7) unless **every** leased slot is named after `--include-leased`; their leases are lost and their
  password files deleted. A name there that is not a leased slot is exit 2, a deny-listed one exit 7. A slot whose
  reset is running is refused (exit 7).
- **The bundle is written first** (with `--yes`), once the refusals have passed, so a failure to write it changes
  nothing. A slot the host fails to destroy is reported and the others are still destroyed. The exit code is the
  first failure's, and the command says slots are left. Running it again finds the orphan and finishes it.
- **Options.** `--remove-root` removes `golden\` too, so it needs `--goldens`. It also removes `sqldata\`, which
  holds `arashouse_admin`'s files, so it does not go with `--keep-sql`. Either mistake is exit 2.

## The elevated half (`teardown.ps1`, `src/broker/teardown-script.ts`)

Windows PowerShell 5.1, plain ASCII, generated from the guards' constants. Every path in it comes from the root
`C:\aras_installations`.

- **Dry run by default.** Without `-Apply` it prints each change of its own as `would do:`, and it runs its two
  children in their own dry runs, printing their lines under `sql:` and `host:`. `-Apply` in a shell that is not
  elevated exits 4.
- **The children must be the reviewed bytes.** It runs `host\setup-host.ps1` and `sql\setup-sql.ps1` only when each
  file's SHA-256 is the one it was generated with. Otherwise it exits 3 before it reads anything.
- **Exit codes:** 0 ok; 1 a step failed or something is left; 2 refused arguments; 3 a child script changed; 4 not
  elevated. Last, it prints `result:` and the result as JSON. With `-Apply` it also writes it to
  `teardown-result.json` next to itself, since the root may be gone by then.

The steps, in order:

1. **The deny-list, before.** It fingerprints the deny-list with the same PowerShell as provisioning and the baseline
   build (`Get-DenyListPrints`, `src/broker/ps-common.ts`): the captain's install roots, every IIS application and pool
   not named `ah-*`, the deny-list's agent services, and the Aras products registered outside the root. It prints the
   objects' **names only**. Reading IIS needs elevation, so with `-Apply` a failed fingerprint stops the run with
   nothing changed. In a dry run the failure is only a note.
2. **What is left.** It lists what of the tool is on the host, by the allowlist's names, derived from `names.ts` for
   every registered flavor (`teardownPatterns()`):
   - **Slots.** Folders under `slots\<key>\` and `vaults\`, IIS applications `/ah-<key>-<NN>` and pools
     `ah-<key>-<NN>-<role>`, services `ArasHouseAgent_<key>_<NN>`, databases `arashouse_<key>_<NN>` and their
     `_dbo`/`_reg` logins.
   - **Baseline builds' leftovers.** `golden-build\<key>[.<suffix>]`, `/ah-build-<key>`, `arashouse_build_<key>`
     and its logins.
   - **Other kinds.** The goldens, `setup-sql`'s objects, the `ArasHouseBroker` service, ticket 44's firewall rule
     `arashouse-http-in-wsl`, a Defender exclusion of the root, and the root itself.

   SQL Server is read only with `LIKE 'arashouse[_]%'` and the two exact login names. Then only derived names are
   kept, so the host's `ah-pp-*` and `arashouse_pp_*` objects, which are not the pool's, are neither listed nor
   touched. With `-Apply`, a kind it cannot read (IIS, SQL Server) stops the run with nothing changed.
3. **Refusals, before any change.** It refuses while any slot is left: `arashouse teardown --yes` from WSL comes
   first. With `-Goldens` or `-RemoveRoot` it also refuses while a baseline build has left its throw-away instance
   (`baseline-build.ps1 -Cleanup` removes it, `docs/baselines.md`).
4. **`-Goldens`.** It removes `golden\<key>` for each flavor that has one. Each path must be under `golden\` and
   must hold no junction or link.
5. **SQL, unless `-KeepSql`.** It runs `setup-sql.ps1 -Uninstall`, which uses the captain's Windows login, a
   `sysadmin` (`docs/setup-sql.md`, "Uninstall"). If it fails, the run stops and the broker stays installed.
6. **The broker.** It runs `setup-host.ps1 -Uninstall`, and with `-RemoveRoot` adds `-RemoveRoot` (`docs/setup.md`,
   "Uninstall"). This stops the service, takes its account out of Administrators, deletes the service and removes the
   Defender exclusion if there is one. With `-RemoveRoot` it then deletes the root, but only if the root holds nothing
   but arashouse folders. On this host the root also holds `gate\`, `instances\` and `spike\`, so `-RemoveRoot`
   refuses until they are gone.
7. **What is left, and the deny-list, after.** It lists what is left again, and prints each deny-list object's name
   with `unchanged`, `changed`, `gone` or `new`. Anything but `unchanged` fails the run. With `-Apply` the run is
   `ok` only when nothing is left of these kinds:
   - always: the slots, the broker, the firewall rule and the Defender exclusion;
   - with `-Goldens`: the goldens and the builds' leftovers;
   - unless `-KeepSql`: the SQL objects;
   - with `-RemoveRoot`: the root.

   Ticket 44's firewall rule has its own undo, `host-tuning.ps1 -Undo Firewall -Apply` (`docs/host-tuning.md`).
   The script names that undo if the rule is there. Ticket 44 applied nothing to this host.

**What it never touches.** It never touches the captain's installers in the repo's `media/`, which are not on the
install root. It does not touch the deny-list's objects: it only fingerprints them. It does not touch anything under
the root that is not arashouse's: `-RemoveRoot` refuses rather than delete it. It changes no SQL object but
`setup-sql`'s own, and only through that script. It reads no secret and writes none.

## Tests

- `src/core/teardown.test.ts`, against `FakeHost`:
  - a dry run changes nothing;
  - `--yes` writes the bundle, then destroys every slot and orphan;
  - a failed bundle changes nothing;
  - the leased refusal: only an exact, complete `--include-leased` passes;
  - an orphan whose stamp names a lease counts as leased;
  - a running reset is refused;
  - a host failure leaves an orphan that a second run finishes;
  - the options' combinations.
- `src/broker/teardown-script.test.ts`, on the script text:
  - every removal is `Remove-Golden`, inside `Invoke-Change`;
  - the children run only with `-Uninstall`, after the hash check;
  - the refusals come before the first change;
  - SQL is read only by the filter;
  - the deny-list output is names only;
  - no path outside the root;
  - the name patterns admit every derived name and nothing of the host's other objects.
- `src/core/setup-sql.test.ts`: the `-Uninstall` drops name only the script's own objects, and the refusal comes
  before any drop.
- `test/teardown.test.ts`:
  - the bundle's layout and hashes;
  - under Windows PowerShell: the parse, and the refusals of arguments (exit 2), of a changed child (exit 3) and of
    `-Apply` when not elevated (exit 4);
  - with `ARASHOUSE_TEST_LOCALDB=1`, the whole dry run against a throw-away LocalDB instance and a scratch root under
    `staging\`. It is refused while a slot's folder is left. Then it plans the golden's removal, the four SQL drops and
    the broker's uninstall, and changes nothing.
- `test/setup-sql.test.ts` (with `ARASHOUSE_TEST_LOCALDB=1`): `-Uninstall` on LocalDB is refused while a slot
  database is left; then it makes the four drops; then it has nothing to drop.
- `test/cli.test.ts`: the dry run, the leased refusal and the option errors.

## On the host

Read-only, as the worker, on 2026-10-28:

- `arashouse teardown --goldens` (a dry run, from a scratch `ARASHOUSE_HOME`) listed through the broker the one slot
  on the host, `12sp9-31`, another lane's, as an orphan it would destroy. Then it printed the elevated plan.
- `teardown.ps1 -KeepSql` (a dry run, not elevated, from a bundle generated for a scratch root, so its SQL reads went
  to the host's instance) refused on that slot's database `arashouse_12sp9_31`. It reported IIS and the deny-list as
  unread without elevation.

The full cycle the ticket asks for has not been run yet: setup, provision one slot, teardown, and the host compared
with the pre-setup inventory from `spike/00-preflight.ps1`. On this host, `teardown --yes` destroys every slot of
the pool, whichever lane made it. `teardown.ps1 -Apply` then removes the broker and the SQL objects that every lane
uses, until `arashouse setup` and `setup-sql` are run again. It is a captain sitting, for when the captain wants
everything gone.
