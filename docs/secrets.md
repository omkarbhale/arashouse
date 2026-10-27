# Secrets

One module family handles every secret, in `src/core/secret.ts`, `redact.ts`, `secret-store.ts`, `licence.ts`, plus the no-echo TTY read in `src/cli/tty.ts` and the broker's client token in `src/broker/token.ts`. Six kinds exist: the SQL `sa` password (`sql-sa`; unused, since `sa` is rejected on this host and ticket 22 connects with Windows authentication, `docs/setup-sql.md`), licence keys (`licence`), per-lease Aras passwords (`lease-password`, ticket 34), a slot's SQL login passwords (`sql-login`, which the config edit list writes into the slot's config; `docs/edits.md`) the broker's client token (`broker-token`, `docs/broker.md`) and an Aras login password that is not a lease's (`aras-login`): the shipped backup's administrator password, which the baseline build logs in with (`docs/baselines.md`), and a free slot's random `root` password (`docs/lease-credentials.md`).

## Rules

- A secret is read only from a hidden prompt (`Read-Host -AsSecureString` on the Windows side, `ttyPrompter` on the WSL side) or from the environment of a process started for that purpose (`secretFromEnv`, which removes the variable after reading it). Never from a flag.
- A `Secret` prints, serialises and inspects as `[redacted]`. `reveal()` is the only way to read it, and `test/reveal-allowlist.test.ts` resolves every reference to `Secret.reveal` in non-test source with the TypeScript type checker and fails when a file that is not listed there references it, or does so more often than listed. Adding a reference means adding the file to that list in the same PR.
- Everything that is logged goes through `redact` (`redactingSink` wraps a writer so it cannot be bypassed). `redact` replaces the value of every `Secret` created in the process, in the forms it travels in (as typed, URL-encoded, JSON-escaped, base64), and these shapes: a key named `lic_key`, `act_key`, `LICENSEKEY`, `password`, `passwd`, `pwd`, `secret` or `token` followed by `=` or `:` and a value (bare, quoted, or in JSON); `Authorization: ...`; `Bearer ...`; `Basic ...`; `-P <x>`; `--password <x>`. Values shorter than four characters are caught only by their shape.
- Errors are printed through `redactError`, never as raw `message` and `stack`.
- Host-side storage, when something must persist: machine-scope DPAPI blobs at `<root>\secrets\<name>.bin` (`secretFile` in `src/core/names.ts`), ACL'd to SYSTEM and the broker account (the broker, tickets 20 and 21). The WSL side persists nothing secret except the per-lease password file for `run --lease`: `LeaseFileStore` (`src/core/lease-files.ts`) keeps it at `$ARASHOUSE_HOME/leases/<lease_id>` (mode 0600, folder 0700), written by `get` and deleted by `return`. The `SecretStore` interface in `secret-store.ts` is the contract; `MemorySecretStore` is the test double. A free slot's random Aras `root` password is stored host-side as `slot-<key>-<NN>-root` (`aras-login`) until `setLeaseCredentials` replaces it with the lease's and deletes it (`docs/lease-credentials.md`).

## Licence keys

"if one is needed, it should ask for it" (the captain). Each flavor carries `licence: { line, required }`. `ensureLicence(flavor, step, { store, prompter })`:

1. returns `undefined`, asking nothing, when the step does not need a key (`licenceNeeded(required, step)`);
2. returns the stored key for the flavor's line (`licence-<line>`) if there is one;
3. otherwise asks once at a hidden prompt (`Aras licence key for line 14 (not needed if you do not use 14.x): `), stores the answer, and never asks again; steps that need the same key at the same moment share one prompt;
4. with no TTY, or an empty answer, throws `LicenceRequiredError` (exit code 8) and never guesses.

`forgetLicence(line, store)` is for an `arashouse licence forget <line>` command, which does not exist yet. `licenceStatus` backs `doctor`'s `licence line 14: present` once `doctor` is given the host's store (tickets 20 and 21): the key's presence is reported as a boolean only.

`licence.required` is `to-login` for every flavor, and `35` is on line `14`, as [the spike record](spike-record.md) found (section 2, and spike 08): a key is needed to log in, not to install, and the 14.0 key serves 14.35. So there are two lines, `12` and `14`. The baseline build (ticket 24) takes the key only for its login check, at a hidden prompt or from the captain's own DPAPI file, and keeps it nowhere (`docs/baselines.md`).

## Not here

The worker commands and the exit-code table are in `docs/cli.md`; `doctor` is in `docs/cli.md`; the DPAPI store and its ACLs are tickets 20 and 21; the `sa` prompt is ticket 22; setting the lease password on the slot is `docs/lease-credentials.md` (ticket 34).
