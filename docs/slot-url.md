# The slot URL and the WSL-side probe

A lease is useless if its URL does not work from WSL. Two functions in `src/host`, pure HTTP from WSL
(no broker):

## `hostAddress(alias)` (`src/host/url.ts`)

The address WSL uses for the Windows host; the URL handed out is `http://<address>/<alias>`
(`slotUrl`), e.g. `http://172.19.0.1/ah-12sp9-01`.

1. `ARASHOUSE_HOST_ADDR` (host name or IPv4, optional `:port`) wins and is not probed.
2. Otherwise the WSL default gateway from `ip route show default`, then `localhost` (mirrored
   networking mode). Each gets an anonymous `GET /<alias>/Client/`, then `GET /<alias>/DBList.aspx`;
   the first whose `Client/` is not 404 and whose `DBList.aspx` answers 200 with a `<DBList>` document
   (an empty list counts) is chosen. This keeps a LAN router (the gateway in mirrored mode) that
   answers 302/401/403 to any path from being mistaken for the host. A slot answering 500 on every
   path is therefore not discoverable by address; set `ARASHOUSE_HOST_ADDR` or fix the slot.
3. The answer is cached for the process, never stored in the state file (it changes when WSL
   restarts). A failure is not cached; it throws `Unreachable` naming what was tried.

Each candidate may take as long as a cold start (60 s by default), so a gateway that silently drops
packets costs one timeout before `localhost` is tried.

## `probeSlot(url, database)` (`src/host/probe.ts`)

Three anonymous GETs, run together:

| check | passes when |
|---|---|
| `Client/` | 200 to 399 |
| `OAuthServer/.well-known/openid-configuration` | 200 |
| `DBList.aspx` | lists exactly one database, this slot's |

The result holds a boolean, the HTTP status and the milliseconds of each, plus the database ids
`DBList.aspx` listed (at most 20); no other response body is kept, and the detail strings never quote
one. The first probe of a URL in a process uses the cold timeout (60 s; cold starts took up to 41.5 s,
design 8.3), later ones the warm timeout (5 s). After a reset recycles the slot's pools, call
`forgetWarm(url)` or pass `warm: false`.

Before anything is contacted, `url` and `database` are vetted: `http` only, no credentials, query or
extra path, and the alias and database must be the pair derived for one slot (`assertOwned`), so a
deny-listed alias such as `12sp9` or `InnovatorServer23` is `Refused`.

Callers: `get` (final sanity before handing out), `doctor`, and the WSL half of ticket 32's health
check. Tests run against a local HTTP server standing in for a slot (`src/host/fake-slot.ts`); the real
host is not contacted.
