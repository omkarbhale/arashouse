# Secrets

One module family handles every secret, in `src/core/secret.ts`, `redact.ts`, `secret-store.ts`, `licence.ts`, plus the no-echo TTY read in `src/cli/tty.ts`. Three kinds exist: the SQL `sa` password (`sql-sa`, ticket 22), licence keys (`licence`) and per-lease Aras passwords (`lease-password`, ticket 34).

## Rules

- A secret is read only from a hidden prompt (`Read-Host -AsSecureString` on the Windows side, `ttyPrompter` on the WSL side) or from the environment of a process started for that purpose (`secretFromEnv`, which removes the variable after reading it). Never from a flag.
- A `Secret` prints, serialises and inspects as `[redacted]`. `reveal()` is the only way to read it, and `test/reveal-allowlist.test.ts` resolves every reference to `Secret.reveal` in non-test source with the TypeScript type checker and fails when a file that is not listed there references it, or does so more often than listed. Adding a reference means adding the file to that list in the same PR.
- Everything that is logged goes through `redact` (`redactingSink` wraps a writer so it cannot be bypassed). `redact` replaces the value of every `Secret` created in the process, in the forms it travels in (as typed, URL-encoded, JSON-escaped, base64), and these shapes: a key named `lic_key`, `act_key`, `LICENSEKEY`, `password`, `passwd`, `pwd`, `secret` or `token` followed by `=` or `:` and a value (bare, quoted, or in JSON); `Authorization: ...`; `Bearer ...`; `Basic ...`; `-P <x>`; `--password <x>`. Values shorter than four characters are caught only by their shape.
- Errors are printed through `redactError`, never as raw `message` and `stack`.
- Host-side storage, when something must persist: machine-scope DPAPI blobs at `<root>\secrets\<name>.bin` (`secretFile` in `src/core/names.ts`), ACL'd to SYSTEM and the broker account (the broker, tickets 20 and 21). The WSL side persists nothing secret except the per-lease password file for `run --lease` (ticket 34). The `SecretStore` interface in `secret-store.ts` is the contract; `MemorySecretStore` is the test double.

## Licence keys

"if one is needed, it should ask for it" (the captain). Each flavor carries `licence: { line, required }`. `ensureLicence(flavor, step, { store, prompter })`:

1. returns `undefined`, asking nothing, when the step does not need a key (`licenceNeeded(required, step)`);
2. returns the stored key for the flavor's line (`licence-<line>`) if there is one;
3. otherwise asks once at a hidden prompt (`Aras licence key for line 14 (not needed if you do not use 14.x): `), stores the answer, and never asks again; steps that need the same key at the same moment share one prompt;
4. with no TTY, or an empty answer, throws `LicenceRequiredError` (exit code 8) and never guesses.

`forgetLicence(line, store)` backs `arashouse licence forget <line>`. `licenceStatus` and `formatLicenceStatus` back `doctor`'s `licence line 14: present`: the key's presence is reported as a boolean only.

`licence.required` is provisional (`to-install` for every flavor) until ticket 09 reports whether install, login or neither needs a key, and whether one key serves `23` and `35`; the registry is data, so the answer changes one line per flavor.

## Not here

The CLI commands (`licence forget`, `doctor`, exit-code table) are ticket 15 and 16; the DPAPI store and its ACLs are tickets 20 and 21; the `sa` prompt is ticket 22; the lease password and its 0600 file are ticket 34.
