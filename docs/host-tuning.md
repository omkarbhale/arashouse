# Host settings: the operator's choice

Tickets 44 and 55. arashouse runs on the host as it is. No code path requires, applies or offers to apply a host-wide
setting: not the WSL memory cap, SQL Server's `max server memory`, a Defender exclusion, the firewall or the power
plan. The captain (2026-10-28): "Build arashouse cleanly, regardless of wherever it will run. I will make the host
settings changes if needed, put that on hold."

Where a setting would help the pool, `arashouse doctor` reports it as an `advice` line: the value seen, the value
recommended, and why. Advice is never a failure or a warning and never changes doctor's exit code (`docs/cli.md`).
The operator decides whether to apply it, by hand, outside arashouse. Uninstall still removes anything an earlier
arashouse version applied (below).

## Measured on the laptop (2026-10-27, `scripts/host-tuning.ps1` inventory, not elevated)

| | value |
|---|---|
| Windows RAM | 32277 MB total; 2491 to 2993 MB free across three reads |
| WSL VM (`vmmemWSL`) | 14.8 to 15.3 GB working set. There is no `.wslconfig`, so the cap is WSL's default of half the RAM (15.7 GB inside: about 8 to 9.6 GB used by the running sessions, the rest page cache) |
| SQL Server | `max server memory` 2147483647 (the default: uncapped); working set 1.94 to 1.96 GB (1.33 GB in the spike) |
| Defender | the exclusion list can be read only elevated |
| Firewall | inbound TCP 80 is allowed by IIS's own rule `IIS-WebServerRole-HTTP-In-TCP`, from any address and on every profile. The host's WSL-side address is 172.19.0.1/20 |
| Power | sleep: never on AC and on battery; hibernate: never on AC, 2147483647 s (effectively never) on battery; the lid action is hidden on this machine |

The spike (ticket 09) measured about 0.4 GB per lightly active slot (1 GB is the planning figure) and 0 GB for an idle one. Three
active slots therefore need about 1.2 to 3 GB on Windows, on top of the `min_free_ram_mb` gate (2048 MB, `docs/governor.md`). With
2.5 to 3 GB free that day, the gate would refuse a lease under load; that is the case doctor's `wsl memory` advice
names.

## The settings

| Setting | Scope | doctor | Recommended | Why |
|---|---|---|---|---|
| WSL memory cap (`[wsl2] memory=<N>GB` in `%UserProfile%\.wslconfig`) | the whole machine; takes effect at `wsl --shutdown`, which ends every WSL session | `advice  wsl memory`, when doctor runs in WSL and Windows has less free RAM than the leases still to come up to `max_active` need (`min_free_ram_mb` each, `docs/governor.md`) | the WSL VM's size less that shortfall, in whole GB (never under 4 GB) | each `get` needs `min_free_ram_mb` free on Windows; a smaller WSL VM gives that room back. On this laptop that was about 12 GB with `autoMemoryReclaim=gradual` |
| SQL Server `max server memory (MB)` | the whole instance, the operator's own databases too | `advice  sql max server memory`, when it is uncapped (2147483647, the default). The broker reads it with its own login (`hostInfo`); it never sets it | 4096 MB | about twice SQL Server's 1.9 GB working set; uncapped, its buffer pool grows into the RAM active slots need |
| Defender exclusion for `C:\aras_installations` | the machine's malware scanning | none | off | a reset takes about 10 s with Defender on (ticket 06, map Q9), so speed does not need it; an exclusion is a security trade-off |
| Firewall: inbound port 80 from the WSL range only | every IIS site, the operator's own installs included | none | off | hardening only: an idle slot has a random, unknown password (ticket 31), and narrowing port 80 also cuts LAN access to every other site |
| Power: no sleep during a reset | the machine | none | as the operator likes | a slot left `resetting` by sleep is recovered by the state machine (ticket 14) |

Defender, the firewall and power get no advice line: none of them helps the pool work.

**App pool idle timeout: arashouse's own, not a host setting.** A provision sets the idle timeout on the pools it
creates, `ah-<key>-<NN>-<role>` (10 minutes by default, or what `setup-host.ps1 -SlotIdleTimeoutMinutes` recorded;
`docs/provision.md`). That is a property of arashouse's own slot, like its folder or its database: IIS's
`applicationPoolDefaults` and every other pool on the host are left alone, and the setting goes with the slot when it
is destroyed. So it stays. An idle slot drops to about 0 GB; a request after idle cold-starts it (2 to 2.5 s for
`12sp9` after a reset), and `get` warms the slot before handing it out.

## Ticket 44's decisions (2026-10-27)

Defender, the idle timeout, the firewall and power were accepted as recommended, and none of them changed the host.
The WSL cap and SQL `max server memory` were left to the captain and never applied. Ticket 55 then removed the
appliers: these settings are the operator's, not arashouse's.

## Undoing what an earlier version applied: `scripts/host-tuning.ps1`

Ticket 44's version of this script could apply the four items above. It recorded each item's earlier value the first
time it applied it, in `state.json` in its state folder (`-StateDir`, default `%LOCALAPPDATA%\arashouse\host-tuning`).
The script now only reads the settings and undoes what that version recorded. It applies nothing, and refuses the old
apply parameters.

Windows PowerShell 5.1, plain ASCII. Copy it to a Windows path and run it with
`powershell -ExecutionPolicy Bypass -File <path> ...`.

- **No item:** prints the inventory (`now:` lines: RAM, `.wslconfig`, SQL `max server memory`, the Defender
  exclusion, port 80's firewall rules, power) and changes nothing.
- **`-Undo Wsl,Sql,Defender,Firewall`** (any subset): without `-Apply`, the plan (`would do:` lines); with `-Apply`, each undo is
  printed (`do:`) before it is made and checked after, and the inventory before and after goes to
  `out\host-tuning-<UTC time>.json` in the state folder. An item with no record is skipped.
  - **Wsl:** restores the previous `.wslconfig`, or deletes the file if there was none before. It refuses if the file
    changed after the script wrote it. No elevation.
  - **Sql:** sets `max server memory` back to its earlier value, through the current Windows login on `master` over
    shared memory. Elevated.
  - **Defender:** removes the exclusion, but only if the script added it. Elevated.
  - **Firewall:** deletes `arashouse-http-in-wsl` and enables IIS's `IIS-WebServerRole-HTTP-In-TCP` again if it was
    enabled before. Elevated.
- **Exit codes.** 0 ok, 1 an undo did not take (the message says which), 2 refused arguments, 4 not elevated.

```powershell
powershell -ExecutionPolicy Bypass -File host-tuning.ps1                       # read only
powershell -ExecutionPolicy Bypass -File host-tuning.ps1 -Undo Sql,Firewall -Apply   # elevated
```

`setup-host.ps1 -Uninstall` removes a Defender exclusion of the root, which its own `-DefenderExclusion` could add
before ticket 55 (`docs/setup.md`). `teardown.ps1` names the `host-tuning.ps1 -Undo` for anything the state file
records, and fails while ticket 44's firewall rule is left (`docs/teardown.md`).

