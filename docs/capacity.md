# Capacity: three leases at once on the laptop

Ticket 38. The captain's expectation, answer 1: "3 most I would guess". This page proves three leases work at once on
this laptop, that a fourth and a burst of returns are handled, that a broker killed mid-lease or mid-reset leaves a pool
`doctor --fix` puts right, and it records the memory three busy leases take. It confirms or changes the governor's
defaults (`docs/governor.md`).

## The races, offline: `test/races.test.ts`

Several `arashouse` processes at once on the v1 pool (`12sp9` x3, `23` x2, `35` x2) against the fake host
(`ARASHOUSE_HOST=fake`), sharing only the state file and its lock, as workers on the laptop share it. Each process
builds its fake host from the state when it starts. A `slow` fault in `ARASHOUSE_FAKE_FAULTS` waits that long in real
time there (`LiveClock.elapse`), so the resets of several reset workers overlap as they do on the host.

| test | what it proves |
|---|---|
| four gets at once, three flavors (`12sp9`, `23`, `35`, `12sp9`) | three distinct slots and lease ids; the fourth exits 3, `max_active 3 reached (3 leased)` |
| four gets at once, one flavor (`12sp9` x4) | three distinct slots; the fourth exits 3, `no 12sp9 slot is free: 3 slots, 3 leased` |
| a fourth `get --wait` behind three leases | it stands in the queue; when one lease is returned it takes that slot, only after the slot's reset ended `free` |
| three returns at once, and a `get 12sp9 --wait` 0.3 s into the burst (each reset step 1.5 s) | the most resets running at once is `max_resets` (2), with the third slot waiting `dirty` meanwhile; the `get` gets a slot whose reset ended after its last lease; every slot ends `free` and `doctor` passes |
| a reset whose worker died (its host call never answered), then the host gone while a lease is held | with the host gone, `doctor --fix` fails "broker: did not answer" and a `get` exits 6, and the lease is untouched; with the host back, `doctor --fix --yes` restarts the dead reset, the slot ends `free`, and the lease is the same one (id and holder) and `run --lease` still works |

**Ten times in a row.** `for i in $(seq 1 10); do npx vitest run test/races.test.ts || break; done` passed all ten
runs (2026-10-28, on the laptop's WSL, about 27 s each).

## On the host: `test/host/capacity.ts`

The same scenarios on the laptop, from WSL as the worker, non-elevated, against the installed broker and the provisioned
v1 pool (ticket 37, all seven slots `free`), with libs-js `aras-pkg` at `99c19b98` (the e2e tickets' commit). It runs
only when asked (`ARASHOUSE_TEST_E2E=1`, the variables are in `test/host/capacity.test.ts`). Firstmate gave this lane
the host to itself (no other lane leasing; other lanes' builds were running on Windows). Two runs on 2026-10-28, both
passing every step:

- **run 1** (05:17Z to 05:30Z): every step, with the broker killed twice (step 5); its memory sampler took no readings
  (a loop piped into `powershell.exe -Command -` never runs; it now goes as `-EncodedCommand`);
- **run 2** (05:30Z to 05:42Z): every step but the kills, with the memory sampled every 5 s (128 readings) and six
  import-and-export rounds per lease.

### 1. Three gets at once, and a fourth

| | run 1 | run 2 |
|---|---|---|
| `get 12sp9`, `get 23`, `get 35` from three processes at once (`--wait 900`) | `12sp9-01` 14.7 s, `23-01` 15.2 s, `35-01` 15.1 s | 15.3 s, 15.7 s, 15.7 s |
| a fourth, `get 12sp9 --wait 0` | exit 3: `max_active 3 reached (3 leased): no 12sp9 slot can be leased now` | the same |
| a fourth, `get 12sp9 --wait 20` | in `status`'s queue while it waited; exit 3 after 20.4 s | 20.3 s |
| `get 12sp9` x3 from three processes at once | `12sp9-01` 14.5 s, `-02` 17.7 s, `-03` 19.5 s | 18.1 s, 23.1 s, 25.9 s |
| a fourth `get 12sp9 --wait 0` | exit 3: `no 12sp9 slot is free: 3 slots, 3 leased, 0 resetting, 0 quarantined` | the same |
| a fourth `get 12sp9 --wait 20` | queued; exit 3 after 20.1 s | 20.2 s |

Three distinct slots and three distinct lease ids each time.

### 2. Three leases busy, and the memory they take

Each lease imported a scratch package (one Variable) and exported `ItemType:Language` with `aras-pkg`, through
`arashouse run --lease`, all three at once: two rounds in run 1, six in run 2 (47 s). Every import and export exited 0,
on each flavor's own engine (`12.0`, `14.0.7`, `14.35`).

Each busy slot by process tree, just after its work (as `docs/pool.md` measures it):

| slot | run 1 | run 2 |
|---|---|---|
| `12sp9-01` | 4 processes (1 `dotnet.exe`, 3 `w3wp.exe`): 658 MB working set, 875 MB private | 670 MB, 748 MB private |
| `23-01` | 7 processes (`Aras.Client.exe`, `Aras.OAuth.Server.exe`, `Aras.Server.exe`, 4 `w3wp.exe`): 896 MB, 1,001 MB private | 951 MB, 1,147 MB private |
| `35-01` | the same 7: 1,112 MB, 755 MB private | 1,134 MB, 871 MB private |

So three busy leases, one per flavor, take about **2.7 GB** of working set: 0.9 GB each, within the 1 GB a slot was
planned at (ticket 09).

The host every 5 s in run 2 (working sets, MB; `w3wp.exe` and `Aras.*.exe` are every such process on the host, the
pool's and the others'):

| phase | readings | free RAM | WSL VM (`vmmemWSL`) | `w3wp.exe` (27) | `Aras.*.exe` (15) | SQL Server |
|---|---|---|---|---|---|---|
| idle (all seven slots warm) | 6 | 3,862 to 4,229 | up to 11,546 | 1,680 | 3,399 | 1,572 |
| three gets at once | 7 | 3,811 to 4,132 | up to 11,354 | 1,682 | 3,416 | 1,572 |
| **three leases busy** | 8 | **2,482** to 3,956 | up to 12,332 | 1,816 | 3,773 | 1,573 |
| three held, idle | 3 | 3,500 to 3,505 | 11,606 | 1,818 | 3,746 | 1,573 |
| three returned at once | 25 | 3,371 to 5,474 | 11,586 | 1,817 | 3,746 | 1,566 to 1,574 |
| `12sp9` x3 at once | 8 | 3,309 to 3,653 | 11,560 | 1,691 | 3,389 | 1,573 |
| `12sp9` x3 returned at once | 50 | 3,399 to 5,033 | 11,615 | 1,692 | 3,392 | 1,567 to 1,574 |
| after (`doctor`) | 21 | 3,559 to 4,803 | 11,793 | 1,625 | 3,403 | 1,574 |

**The lowest free RAM was 2,482 MB**, at 05:32:09Z with the three leases busy and the WSL VM at its highest (12.3 GB).
That is above `min_free_ram_mb` (2048), so no `get` was held by the RAM gate in either run.

**Every slot was warm throughout, not only the leased three.** A reset ends with a warm-up and a health check, and
`doctor` health-checks every free slot, so after run 1 (and in any busy pool) all seven slots were warm: by pool, at
05:43Z, `12sp9` 509 to 528 MB each, `23` 755 to 784 MB, `35` 926 to 945 MB, about 5 GB for the seven, plus 207 MB for
`ah-pp-35` (not a pool slot). A free slot drops to nothing (`12sp9`) or 54 MB (14.x) only after 10 minutes without a
request (`docs/pool.md`). The governor counts leases, not warm slots, so the measured minimum is close to the worst case
the laptop meets: all seven slots warm and three of them busy.

**WSL's memory.** There is no `.wslconfig` on the host: ticket 44's WSL cap was left to the captain and has not been
applied (`docs/host-tuning.md`). The VM sees 15,748 MB and held 11.2 to 12.3 GB on Windows during the runs.

### 3. Three returned at once

| | run 1 | run 2 |
|---|---|---|
| three `return`s at once (one per flavor) | each exit 0 in 0.13 to 0.14 s | 0.10 to 0.13 s |
| the most resets running at once | 2 (`max_resets`), a third slot `dirty` meanwhile | the same |
| every slot `free` again | 113.6 s after the returns | 138.7 s |
| `12sp9` x3 returned at once, with a `get 12sp9 --wait 900` 1 s later | the most at once 2, a third `dirty` meanwhile; the `get` got `12sp9-01` after 75.1 s, once its reset ended (`leased->dirty`, `dirty->resetting`, `resetting->free`, `free->leased`), and logged in with its own password | 2; 115.5 s |
| every slot `free` again, the `get`'s too once returned | 193.5 s | 283.8 s |

A reset's steps (from the events log) took 48 to 68 s with no other reset running, and up to 98 s with a second beside
it (run 2's `12sp9` burst: golden 4.0 s, quiesce 12.8 s, database 8.6 s, tree 11.2 s, start 16.4 s, health 45.1 s);
the spike's about 10 s (ticket 06) was the stop, mirror, restore and first request alone. `max_resets` 2 holds; three
returns of one flavor are all free in 3 to 5 minutes, and a `get` in the burst waits for the first of them.

### 4. The broker killed during a lease and during a reset

`test/host/kill-broker.ps1`, run elevated by firstmate's gate, waited for the harness's request files and each time ended
the `ArasHouseBroker` service's whole process tree at once (`taskkill /T /F`), as a crash or a power cut would; the
service's restart recovery brought it back by itself both times.

| | what happened |
|---|---|
| **kill 1, while `23-01` was leased** (05:18:49Z) | the tree: `ArasHouseBroker.exe`, `node.exe`, `conhost.exe`; running again 6 s later by its recovery. `doctor --fix --yes` exit 0 (88.6 s). `23-01` still `leased`, the same lease id and holder, and `root` still logs in with the lease's password. |
| **kill 2, 8 s into `23-01`'s reset** (05:20:38Z) | the tree: `ArasHouseBroker.exe`, `node.exe`, `conhost.exe` and the step it was running (`powershell.exe`, `conhost.exe`); running again 11.5 s later by its recovery. The reset worker lost the broker and gave the slot back: `resetting -> dirty`. `doctor --fix --yes` exit 0 (50.7 s) started a reset worker, which reset it in 50 s (quiesce 2.5 s, database 6.9 s, tree 8.2 s, start 10.1 s, health 18.7 s), and every slot was `free` 27 s after `doctor` ended. |

No lease was lost, no slot was quarantined, and run 1's closing `doctor` passed every check. The deny-list objects the
worker can read were the same before and after each run.

### 5. Two slots in one browser

The design (5.2) feared that two slots opened in one browser at `http://<host>/<alias>` share a cookie jar, as they share
an origin. The browser tool could not reach a Chrome from this lane, so the browser's login was replayed from Node over
HTTP for one slot of each flavor, with the lease's password (in memory only) and a cookie jar keyed as a browser keys it
(name, path): the OAuth server's `connect/authorize`, its login page, the login form's POST (the password RSA-encrypted
with the page's public key, as its `login.js` does), and the redirect to `authorize/callback`.

| flavor | cookies set, by name and Path |
|---|---|
| `12sp9` | `.AspNetCore.Antiforgery.bFE3ud8JNpc`, `Aras.OAuth.Session`, `Aras.OAuth`, each `path=/ah-12sp9-02/OAuthServer` |
| `23` | `.AspNetCore.Antiforgery.S5ovW-iLqEg`, `Aras.OAuth.Session`, `Aras.OAuth`, each `path=/ah-23-01/OAuthServer`, `samesite=lax` (the antiforgery one `strict`) |
| `35` | the same names, each `path=/ah-35-02/OAuthServer` |

Every cookie is scoped to its own slot's OAuth server path, so a browser keeps a separate set per slot even where the
names are the same (every slot's `Aras.OAuth`, and the antiforgery cookie of every 14.x slot), and signing in to one
slot does not replace the other's session. Each slot's sign-in session lives in those cookies.

In the page, `12sp9`'s client keeps the signed-in user in `sessionStorage` under oidc-client's key, which names the
slot's OAuth authority (`Client/Modules/aras.innovator.AuthenticationFramework/Scripts/OAuthClient.AuthorizationCodeGrant.js`);
`sessionStorage` is also per tab. The 14.x clients' bundles were searched for where they keep the user and it was not
found; what was found there is `sessionStorage` (per tab) with keys that do not name the slot (Release 35's
`compiledMethodsBundlePath`, `skipBrowserCertificationDialog`), which two slots share only within one tab. Not tested: a
real browser with two slots signed in side by side (the browser tool could not reach a Chrome here).

**Host-header bindings are not needed** for two slots in one browser: the sign-in cookies do not collide. No ticket is
opened for them.

## The defaults, confirmed

| setting | default | verdict |
|---|---|---|
| `max_active` | 3 | **confirmed.** Three leases of three flavors, busy at once, with every other slot warm, left at least 2,482 MB free. |
| `max_resets` | 2 | **confirmed.** It held under both bursts, and two at once already made each reset up to half again as long (98 s against 48 to 68 s alone). |
| `min_free_ram_mb` | 2048 | **kept at 2048, not lowered to 1024** (ticket 09's suggestion). A slot leased cold warms up by 0.5 to 1.1 GB (its working set busy, against 0 to 54 MB idle), so at 1024 a `get` could leave the laptop with almost nothing free. At 2048 it held no `get` in either run. |
| `min_free_disk_gb` | 10 | unchanged (204 GB free; `docs/pool.md`). |

Nothing here needs ticket 44's WSL cap now; it stays the captain's option if the laptop's other work grows.

## Seen on the way

- **WSL interop refusals.** After the runs, while other lanes ran builds through Windows interop, a few `get`s exited 6
  ("cannot reach the broker: the client exited 1 with no response: `UtilAcceptVsock: accept4 failed 110`"): WSL could
  not start the Windows `node.exe` that carries the request, so the broker never saw it. A retry a little later worked.
  `get` does no harm (nothing was leased) and says the host did not answer; a retry of an interop start that never
  reached the broker would be a separate change to the transport (`src/host/broker-transport.ts`), not made here.
- **Three slots quarantined by slow logins on a loaded host.** After the runs, the browser check above leased and
  returned one slot of each flavor six times (06:00Z to 06:15Z) while other lanes' builds ran on Windows and this lane
  read the slots' client bundles over `/mnt/c`. Three of those resets (`12sp9-01`, `12sp9-02`, `35-01`, 06:18Z to 06:24Z)
  failed their health check twice because `root`'s login took 100 to 120 s and was cut off ("The operation was
  canceled", "answer in 120 s"); two others passed with health checks of 158 s and 284 s. The reset counts a failed
  health check as a failed step, so the slots were quarantined, as designed, and never handed out. `arashouse repair`
  reset each in 82 to 97 s (06:38Z to 06:43Z) and every slot was `free` again. So a busy host can cost slots their
  place in the pool until an operator repairs them; whether a health check that only timed out should leave the slot
  `dirty` for a later try instead of counting toward quarantine is a question for a later ticket, not changed here.
