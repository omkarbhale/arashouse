# The slot URL and the probe

A lease is useless if its URL does not work where its holder runs: natively on Windows, or in WSL. Two functions in
`src/host`, pure HTTP from the CLI's process (no broker):

## `hostAddress(alias)` (`src/host/url.ts`)

The address the CLI's process uses for the Windows host; the URL handed out is `http://<address>/<alias>`
(`slotUrl`), e.g. `http://localhost/ah-12sp9-01` natively, or `http://172.19.0.1/ah-12sp9-01` from WSL.

1. `ARASHOUSE_HOST_ADDR` (host name or IPv4, optional `:port`) wins and is not probed.
2. Natively on Windows it is `localhost`, unprobed: the host is this machine.
3. From WSL, through the launcher, the Windows process builds the URL with the address WSL reaches the host at, so
   `get --json` and `run` read as they did from WSL: the launcher passes the default gateway as `ARASHOUSE_HOST_ADDR`
   in NAT mode (`wslinfo --networking-mode`; Windows reaches its own gateway address too), and none in mirrored mode,
   where `localhost` serves both sides (`docs/windows-native.md`). A caller's own `ARASHOUSE_HOST_ADDR` is passed on
   instead.
4. Where it still runs in WSL itself (the WSL-side tests and host suites, a WSL with no Windows Node), the probe is
   unchanged: the WSL default gateway from `ip route show default`, then `localhost` (mirrored
   networking mode). Each gets an anonymous `GET /<alias>/Client/`, then `GET /<alias>/Server/DBList.aspx`;
   the first whose `Client/` is not 404 and whose `DBList.aspx` answers 200 with a `<DBList>` document
   (an empty list counts) is chosen. This keeps a LAN router (the gateway in mirrored mode) that
   answers 302/401/403 to any path from being mistaken for the host. A slot answering 500 on every
   path is therefore not discoverable by address; set `ARASHOUSE_HOST_ADDR` or fix the slot.
   The answer is cached for the process, never stored in the state file (it changes when WSL
   restarts). A failure is not cached; it throws `Unreachable` naming what was tried.

Each candidate may take as long as a cold start (60 s by default), so a gateway that silently drops
packets costs one timeout before `localhost` is tried. (The fake host builds its URLs with `ARASHOUSE_HOST_ADDR`, else
`127.0.0.1`, and probes nothing.)

## `probeSlot(url, database)` (`src/host/probe.ts`)

Three anonymous GETs, run together:

| check | passes when |
|---|---|
| `Client/` | 200 to 399 |
| `OAuthServer/.well-known/openid-configuration` | 200 |
| `Server/DBList.aspx` | lists exactly one database, this slot's |

The result holds a boolean, the HTTP status and the milliseconds of each, plus the database ids
`DBList.aspx` listed (at most 20); no other response body is kept, and the detail strings never quote
one. The first probe of a URL in a process uses the cold timeout (60 s; cold starts took up to 41.5 s,
design 8.3), later ones the warm timeout (5 s). After a reset recycles the slot's pools, call
`forgetWarm(url)` or pass `warm: false`.

Before anything is contacted, `url` and `database` are vetted: `http` only, no credentials, query or
extra path, and the alias and database must be the pair derived for one slot (`assertOwned`), so a
deny-listed alias such as `12sp9` or `InnovatorServer23` is `Refused`.

Callers: a bootstrap recipe's health step (`docs/bootstrap.md`, ticket 42), from the CLI's process at the lease's URL.
Otherwise `get` relies on the broker's health check (`docs/health.md`, ticket 32), which runs the same three requests
on the Windows side. Tests run against a local HTTP server standing in for a slot (`src/host/fake-slot.ts`); the real
host is not contacted.
