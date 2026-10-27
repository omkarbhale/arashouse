# The per-lease password: `setLeaseCredentials`

Ticket 34. A free slot cannot be logged in to with the shipped credentials, and a leaseholder gets a password that
exists only for that lease and dies with it.

## The lifecycle

1. **Free.** After a reset, the slot's `root` has a random password that nobody knows. The broker keeps it in the host
   secret store as `slot-<key>-<NN>-root` (machine-scope DPAPI under `<root>\secrets\`, kind `aras-login`). The
   reset makes it after the pools start (ticket 32): SQL cannot set an Aras password (spike 06), so it is an AML `edit`
   through the slot's own server.
2. **`get`.** The CLI makes the lease's password (128 random bits, base64url: 22 characters) and keeps it in the
   lease file `$ARASHOUSE_HOME/leases/<lease_id>` (0600, in a 0700 folder; `src/core/lease-files.ts`). It hands the
   host only the handle `lease-<lease_id>` (`setLeaseCredentials(slot, { secretRef })`). `BrokerHost` looks the handle up
   in that store and sends the password on the broker request line. The broker sets it for `root` and `admin` (below).
   `get --json` shows it once, or `get --password-fd <n>` writes it to a descriptor instead (`docs/cli.md`).
3. **Leased.** `arashouse run --lease <lease_id>` puts it in `ARAS_PASSWORD` of its child only. Nothing else on either
   side knows it: the broker deleted the free slot's stored password once the lease's was set.
4. **`return`.** The lease file is deleted with the lease. The reset restores the golden database over the slot's
   (ticket 31), which carries none of the lease's passwords, and makes a new random one (step 1). So a stale password
   cannot reach the next lease, and `get` on a slot that was not reset since its last lease fails (no stored password)
   rather than reusing it.

The state file holds only the lease; the events log, the broker's audit log and `status` hold no password
(`src/core/lease.test.ts`, `test/cli.test.ts`, `src/broker/lease-credentials.test.ts` grep for it).

## What the broker does

`src/broker/lease-credentials.ts`, under the slot's lock (one provision, destroy, start, stop, database reset or
credential change per slot at a time; a second is `Retryable`):

1. **The argument.** `args.password` only, 16 to 128 letters, digits, `-` or `_`. It is wrapped in a `Secret` before
   it is checked, so `redact` replaces it in every line, including the error for a malformed one; the error never
   quotes it. The audit log records the verb, slot and outcome only (`docs/broker.md`).
2. **The slot.** One without a stamp is `Refused` (not provisioned). One without a stored `root` password is
   `Retryable`: it has not been reset since it was provisioned or last leased, and `get` sends it to be reset.
3. **The edit** (`src/broker/aras-http.ts`, on `http://localhost/<alias>`): an OAuth password grant as `root` with the
   stored password (`client_id` `IOMApp`, the password as its MD5 hex, as the Aras clients send it; the same request
   the baseline build's login check makes), then `ApplyItem` of
   `<Item type="User" action="edit" where="[User].login_name='<login>'"><password><MD5 hex></password></Item>` for
   `admin` and then `root`, with the token as a bearer. The login names are fixed, and the edit refuses any name that
   is not a plain one.
4. **The proof.** A grant as `root` with the lease's password must succeed.
5. **Forget.** The stored `root` password is deleted.

A server that refuses the stored password, the edit or the new password is `Quarantine`: the slot is not in the state
a free slot must be in. A server that does not answer (a timeout, a 5xx, no connection) is `Retryable`. Either way
`get` abandons the lease: its password file is deleted and the slot goes to quarantine or to be reset
(`docs/lease.md`). The verb's bound is 10 minutes (a login, two edits and a login, each up to 2 minutes on a cold
server). A destroy deletes the stored password with the slot's other secrets (`docs/provision.md`).

The password reaches the server only as its MD5 hex in a request body, the token only in the `Authorization` header.
The MD5 is registered as a secret too, since it logs in as well as the password does.

## Not done here, and why

- **The host proof** (log in as `root` with the lease's password, not with the shipped one; after `return` and the
  reset, not with the old one) is ticket 35's. No slot can log in yet: a login needs the whole `<License>` element in
  the slot's config, which nothing stores or renders (ticket 34b, `docs/provision.md`), and nothing on the host
  reaches `free` before ticket 32's health check, which is also where the free slot's random `root` password is made.
  Until both land, `get` on the real host fails at the reset, before this verb is reached.
- **Releases 23 and 35.** The edit route was proven on `12sp9` (spike 06). The OAuth grant is the one the baseline
  build passed on all three flavors; the `ApplyItem` edit on the 14.x servers is first run in tickets 36 and 52.
- **A separate `admin` password.** `admin` gets the same value as `root`; nothing asks for another.
