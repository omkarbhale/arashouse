# Secrets

One module family handles every secret, in `src/core/secret.ts`, `redact.ts`, `secret-store.ts`, `licence.ts`, plus the no-echo TTY read in `src/cli/tty.ts` and the broker's client token in `src/broker/token.ts`. Seven kinds exist: the SQL `sa` password (`sql-sa`; unused, since `sa` is rejected on this host and ticket 22 connects with Windows authentication, `docs/setup-sql.md`), licence keys (`licence`), per-lease Aras passwords (`lease-password`, ticket 34), a slot's SQL login passwords (`sql-login`, which the config edit list writes into the slot's config; `docs/edits.md`) the broker's client token (`broker-token`, `docs/broker.md`) and an Aras login password that is not a lease's (`aras-login`): the shipped backup's administrator password, which the baseline build logs in with (`docs/baselines.md`), and a free slot's random `root` password (`docs/lease-credentials.md`), and the password of a slot's own OAuth signing certificate (`oauth-cert`, `docs/reset.md`).

## Rules

- A secret is read only from a hidden prompt (`Read-Host -AsSecureString` on the Windows side, `ttyPrompter` on the WSL side) or from the environment of a process started for that purpose (`secretFromEnv`, which removes the variable after reading it). Never from a flag.
- A `Secret` prints, serialises and inspects as `[redacted]`. `reveal()` is the only way to read it, and `test/reveal-allowlist.test.ts` resolves every reference to `Secret.reveal` in non-test source with the TypeScript type checker and fails when a file that is not listed there references it, or does so more often than listed. Adding a reference means adding the file to that list in the same PR.
- Everything that is logged goes through `redact` (`redactingSink` wraps a writer so it cannot be bypassed). `redact` replaces the value of every `Secret` created in the process, in the forms it travels in (as typed, URL-encoded, JSON-escaped, base64), and these shapes: a key named `lic_key`, `act_key`, `LICENSEKEY`, `password`, `passwd`, `pwd`, `secret` or `token` followed by `=` or `:` and a value (bare, quoted, or in JSON); `Authorization: ...`; `Bearer ...`; `Basic ...`; `-P <x>`; `--password <x>`. Values shorter than four characters are caught only by their shape.
- Errors are printed through `redactError`, never as raw `message` and `stack`.
- Host-side storage, when something must persist: machine-scope DPAPI blobs at `<root>\secrets\<name>.bin` (`secretFile` in `src/core/names.ts`), ACL'd to SYSTEM and the broker account (the broker, tickets 20 and 21). The WSL side persists nothing secret except the per-lease password file for `run --lease`: `LeaseFileStore` (`src/core/lease-files.ts`) keeps it at `$ARASHOUSE_HOME/leases/<lease_id>` (mode 0600, folder 0700), written by `get` and deleted by `return`. The `SecretStore` interface in `secret-store.ts` is the contract; `MemorySecretStore` is the test double. A free slot's random Aras `root` password is stored host-side as `slot-<key>-<NN>-root` (`aras-login`) until `setLeaseCredentials` replaces it with the lease's and deletes it (`docs/lease-credentials.md`). The password of a slot's OAuth signing certificate is stored as `slot-<key>-<NN>-oauth` (`oauth-cert`), made new with the certificate by every render of the slot's configs, so the health check can verify `OAuth.config` (`docs/reset.md`).

## Licence keys

"if one is needed, it should ask for it" (the captain). Each flavor carries `licence: { line, required }`. `ensureLicence(flavor, step, { store, prompter })`:

1. returns `undefined`, asking nothing, when the step does not need a key (`licenceNeeded(required, step)`);
2. returns the stored key for the flavor's line (`licence-<line>`) if there is one;
3. otherwise asks once at a hidden prompt (`Aras licence key for line 14 (not needed if you do not use 14.x): `), stores the answer, and never asks again; steps that need the same key at the same moment share one prompt;
4. with no TTY, or an empty answer, throws `LicenceRequiredError` (exit code 8) and never guesses.

`forgetLicence(line, store)` is for an `arashouse licence forget <line>` command, which does not exist yet. `licenceStatus` backs `doctor`'s `licence line 14: present`: the broker's `hostInfo` reports each line's licence as present or absent (whether its blob exists; a boolean only, never a value), and `doctor` prints that.

`licence.required` is `to-login` for every flavor, and `35` is on line `14`, as [the spike record](spike-record.md) found (section 2, and spike 08): a key is needed to log in, not to install, and the 14.0 key serves 14.35. So there are two lines, `12` and `14`. The baseline build (ticket 24) takes the key only for its login check, at a hidden prompt or from the captain's own DPAPI file, and keeps it nowhere (`docs/baselines.md`).

## The licence a slot logs in with

A login needs the whole `<License>` element, not the key alone ("License Key is invalid", `docs/baselines.md` run 5).
So the stored secret `licence-<line>` (`licence-12` for `12sp9`, `licence-14` for `23` and `35`) holds the four values
together, `lic_key`, `act_key`, `lic_type` and `company`, as one JSON object in one machine-scope DPAPI blob
(`encodeLicence` and `decodeLicence` in `src/core/licence.ts`). A stored value that is not a JSON object is a key alone,
as `ensureLicence`'s prompt stores it, and reads as `lic_key` with the rest blank. Every value becomes a `licence` Secret
as it is read, so `redact` replaces each of them in every log line and error. A provision and every reset render all
four into the slot's `InnovatorServerConfig.xml` (`docs/edits.md`); with nothing stored they render blank, and the
result says the slot cannot log in yet.

**Storing it.** The captain-approved source is an existing install's `InnovatorServerConfig.xml`, read read-only, as
`spike/30-licence-reuse.ps1` and the baseline builds' login checks did. `scripts/store-licence.ps1` does it, run
elevated (the captain, or firstmate's elevated gate):

```
powershell -NoProfile -ExecutionPolicy Bypass -File store-licence.ps1 -Line 12 -SourceConfig '<Program Files>\<install>\Innovator\InnovatorServerConfig.xml' -Apply
```

`-SourceConfig` must be an `InnovatorServerConfig.xml` directly under `<install>\Innovator\` in an `Aras*` folder under
Program Files; `-Line` is `12` or `14`. Without `-Apply` it prints the plan and reads nothing; with it, unless elevated,
it refuses before reading. It reads the `<License>` element and nothing else, and sends the four values to the broker's
`storeLicence` verb on the stdin of the broker's own client (`<root>\broker\app\broker\client.js`), never in an
argument. The broker (`src/broker/licence-verbs.ts`) checks them (a non-empty `lic_key`; a refusal names a field, never a
value), stores them in its DPAPI store, replacing an earlier licence of the line, and answers with the line only; the
audit log records the verb and the outcome, as for every verb, and never a request's `args`. The script prints only
`stored the licence for line 12`, or an error that names no value; it writes no file and changes nothing of the install.
Exit codes: 0 stored, 1 the broker refused or failed, 2 a wrong parameter or precondition (nothing sent), 6 the broker
could not be reached. `storeLicence` is not a host-driver method, since no WSL caller has a licence to send; the hidden
prompt of `ensureLicence` stays the fallback for a line with no such source.

### Measured on the host (2026-10-28, ticket 34b)

Through firstmate's elevated gate, after the broker was updated from this branch: `store-licence.ps1 -Line 12` with the
captain's existing 12.0 install's config as the source (read only) exited 0 and printed `stored the licence for line
12`; `arashouse doctor` then reported `licence line 12: present` and `licence line 14: absent`. From WSL as the worker,
under a scratch `ARASHOUSE_HOME`:

- `provision 12sp9 1` made `12sp9-01` in 25.1 s, with no "cannot log in" note: its `<License>` carried `lic_type`,
  `lic_key` and `act_key` from the stored licence and `company` blank, as the source holds it. Its health check
  (ticket 32) then quarantined it at the login only, since no `root` password is stored for it yet (`ootb-root-12sp9`
  is ticket 35's).
- `repair 12sp9-01` (one reset) wrote the config again from golden's bytes; the health check's `configs` check, which
  holds every edit of the list, passed.
- An OAuth password grant as `root` on `ah-12sp9-01`, with the shipped backup's password, run through the gate: `login:
  ok`. Before this ticket a slot's server refused every login ("License Key is invalid" with the key alone).
- No value of the licence (each of four characters or more) was found in the broker's audit log and service log
  (`<root>\logs`, read through the gate), the events log, the state file, or the output of `doctor`, `provision`,
  `repair` and `destroy`; the checks printed counts only.
- `destroy 12sp9-01 --yes` removed the slot and everything of it.

## Not here

The worker commands and the exit-code table are in `docs/cli.md`; `doctor` is in `docs/cli.md`; the DPAPI store and its ACLs are tickets 20 and 21; the `sa` prompt is ticket 22; setting the lease password on the slot is `docs/lease-credentials.md` (ticket 34).
