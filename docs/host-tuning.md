# Host tuning for three active slots

Ticket 44. The captain chose the laptop for good, with about three leases active at once ("3 most I would guess"). This page covers
what is tuned on the host for that, the script that applies it, and how to undo each item. The captain picks the items and when to
apply them. Applying the WSL cap ends every WSL session, so the captain also picks when that happens.

## Measured before tuning (2026-10-27, `scripts/host-tuning.ps1` inventory, not elevated)

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
2.5 to 3 GB free today, the gate would refuse the first lease under load, so the WSL cap is the item that matters.

## The items

Each item has its own parameter and its own undo. Items 4 and 6 are settings to record, not changes to the host.

| # | Item | Parameter | Elevated | Recommended | Why |
|---|---|---|---|---|---|
| 1 | WSL memory cap | `-WslMemoryGB <N>`, optionally `-WslAutoMemoryReclaim gradual` | no | **12 GB, `gradual`** | 12 GB is about 3 GB under today's 15 GB VM, which leaves about 5.7 GB free on Windows before the slots start and about 2.7 GB with three planning-size slots. That still clears the 2048 MB gate. The design's 8 GB is below what the running sessions use now (8 to 9.6 GB), so it would push them into swap. With `gradual`, WSL also returns idle page cache to Windows. The cap takes effect only at `wsl --shutdown` |
| 2 | SQL `max server memory` | `-SqlMaxServerMemoryMB <MB>` | yes | **4096** | About twice today's working set. It stops SQL Server's buffer pool from taking the room the slots need, and is plenty for restores of 12 to 15 MB backups. The setting covers the whole instance, so the captain's own databases share the cap. It needs no restart |
| 3 | Defender exclusion for `C:\aras_installations` | `-DefenderExclusion` | yes | **off** | A reset takes about 10 s with Defender on (ticket 06), so speed does not need it, and an exclusion is a security trade-off (map Q9) |
| 4 | App pool idle timeout on slot pools | none: ticket 25 sets it at provision | n/a | **20 minutes, idle action Terminate** (IIS's default) | An idle slot drops to about 0 GB. A request after idle cold-starts the slot (2 to 2.5 s for `12sp9` after a reset; up to 41 s in the design's measurements), and `get` warms the slot before handing it out |
| 5 | Inbound port 80 from the WSL range only | `-FirewallWslOnly` (`-FirewallWslRange`, default `172.16.0.0/12`) | yes | **off** | Port 80 serves every IIS site, the captain's existing installs included, so narrowing it also cuts LAN access to those. Exposure is low: an idle slot has a random, unknown password (ticket 31). Turning it on is hardening only |
| 6 | Power | none | n/a | **keep as measured** (no sleep) | A slot left `resetting` by sleep is recovered by the state machine (ticket 14) |

## The script: `scripts/host-tuning.ps1`

Windows PowerShell 5.1, plain ASCII. Copy it to a Windows path (for example `%LOCALAPPDATA%\arashouse\host-tuning\`) and run it with
`powershell -ExecutionPolicy Bypass -File <path> ...`.

- **No item:** prints the inventory above (`now:` lines) and changes nothing.
- **Dry run by default.** With items but without `-Apply`, it prints the inventory and the plan (`would do:` lines). With `-Apply`,
  every change is printed (`do:`) before it is made and checked after (`done:`), and the inventory before and after is written to
  `out\host-tuning-<UTC time>.json` in the state folder.
- **Undo.** The first apply of an item records its earlier value in `state.json` in the state folder (`-StateDir`, default
  `%LOCALAPPDATA%\arashouse\host-tuning`). `-Undo Wsl,Sql,Defender,Firewall` (any subset) puts the recorded values back:
  - **Wsl:** restores the previous `.wslconfig`, or deletes the file if there was none before. It refuses if the file changed after the
    script wrote it.
  - **Sql:** sets `max server memory` back to its earlier value.
  - **Defender:** removes the exclusion, but only if the script added it.
  - **Firewall:** deletes `arashouse-http-in-wsl` and enables IIS's rule again if it was enabled before.
- **Elevation.** `-Apply` (or `-Undo ... -Apply`) for Sql, Defender or Firewall needs an elevated shell; otherwise the script exits 4.
  Wsl writes only the user's own `.wslconfig` and needs no elevation.
- **Exit codes.** 0 ok, 1 a change did not take (the message says which), 2 refused arguments, 4 not elevated.

What it touches, and nothing else:

- **Wsl:** `%UserProfile%\.wslconfig`. It sets `memory` in `[wsl2]` and `autoMemoryReclaim` in `[experimental]`, and keeps every
  other line. It never runs `wsl --shutdown`.
- **Sql:** `sp_configure 'max server memory (MB)'` on `master`, through the current Windows login over shared memory. `show advanced
  options` is switched on only for the change and then put back. No other database is opened.
- **Defender:** the one path `C:\aras_installations`.
- **Firewall:** adds the rule `arashouse-http-in-wsl` (allow inbound TCP 80 from the WSL range, every profile) and disables
  `IIS-WebServerRole-HTTP-In-TCP`. Before that, it checks that the host's current WSL address is inside the range, so WSL keeps its
  access. If another enabled rule still opens port 80, the script names it and leaves it alone.
- **Power:** read only.

```powershell
# the recommended set: elevated for the SQL item
powershell -ExecutionPolicy Bypass -File host-tuning.ps1 -SqlMaxServerMemoryMB 4096 -Apply
# the WSL cap: no elevation; then `wsl --shutdown` when no session is running
powershell -ExecutionPolicy Bypass -File host-tuning.ps1 -WslMemoryGB 12 -WslAutoMemoryReclaim gradual -Apply
# undo
powershell -ExecutionPolicy Bypass -File host-tuning.ps1 -Undo Sql -Apply
```

## After applying

Ticket 38 runs three leases on the provisioned pool and checks that the free RAM it measures clears `min_free_ram_mb`. That ticket
also decides whether the gate can drop to 1024 MB (ticket 09's follow-up). Ticket 25 sets the idle timeout from item 4 when it
provisions slot pools.
