# arashouse

A pool of disposable Aras Innovator instances (code tree, IIS application and SQL database), one pool per Aras version,
on one Windows laptop, leased the way `treehouse` leases worktrees.
`arashouse get 23 --holder my-task` hands you a clean instance; `arashouse return <lease_id>` gives it back, and it is
reset to out of the box before anyone gets it again. Take out what you want to keep first: returning discards everything.

arashouse runs on Windows Node: from a PowerShell, as the worker user, unelevated, run
`node <arashouse>\dist\cli\index.js <command>` after `npm ci && npm run build`. In WSL, `arashouse <command>` works as
before: it is a launcher that runs the same build on Windows (`docs/windows-native.md`).

- **Using a lease** (a worker): [`docs/using-a-lease.md`](docs/using-a-lease.md).
- **Operating the pool** (setup, repairs, uninstall): [`docs/runbook.md`](docs/runbook.md).
- **Every command and exit code**: [`docs/cli.md`](docs/cli.md).
- **On Windows natively, and the WSL launcher**: [`docs/windows-native.md`](docs/windows-native.md).
- **Contributing**: [`AGENTS.md`](AGENTS.md) (the rules, the layout, the commands).

Flavors: `12sp9` (12.0 SP9), `23` (Release 23, 14.0 SP9), `35` (Release 35, 14.35).

## The docs, by ticket

| ticket | what | doc |
|---|---|---|
| 02 | the installers, kept out of git | [`media/README.md`](media/README.md) |
| 04 to 09 | the slice 0 spikes on the host, and their exit record | [`spike/README.md`](spike/README.md), [`docs/spike-record.md`](docs/spike-record.md), [`05`](docs/spike-05-12sp9-baseline-and-clone.md), [`06`](docs/spike-06-reset-mechanics.md), [`07`](docs/spike-07-release-23.md), [`08`](docs/spike-08-release-35.md) |
| 12 | the host-driver contract and the fake host | [`docs/host-driver.md`](docs/host-driver.md) |
| 11 | the state store and its recovery from the slot stamps | [`docs/runbook.md`](docs/runbook.md#a-lost-or-broken-state-file), [`docs/cli.md`](docs/cli.md#doctor---fix---rebuild-state---deep---yes---json) |
| 13 | leases: get, return, status | [`docs/lease.md`](docs/lease.md) |
| 14, 30, 54, 56 | the reset policy, the tree reset, the per-reset OAuth certificate, a loaded host | [`docs/reset.md`](docs/reset.md) |
| 15, 16 | the CLI and the operator commands | [`docs/cli.md`](docs/cli.md) |
| 17 | the resource governor: `max_active`, RAM, disk | [`docs/governor.md`](docs/governor.md) |
| 18 | the media check | [`docs/media-check.md`](docs/media-check.md) |
| 19 | the config edit list | [`docs/edits.md`](docs/edits.md) |
| 20 | the broker: verbs, pipe, audit log | [`docs/broker.md`](docs/broker.md) |
| 21 | host setup | [`docs/setup.md`](docs/setup.md) |
| 22 | SQL Server setup | [`docs/setup-sql.md`](docs/setup-sql.md) |
| 23, 34b | secrets, licences | [`docs/secrets.md`](docs/secrets.md) |
| 24, 26, 27, 33b | the goldens: build and verify | [`docs/baselines.md`](docs/baselines.md) |
| 25 | provisioning a slot | [`docs/provision.md`](docs/provision.md) |
| 28 | the golden manifest | [`docs/manifest.md`](docs/manifest.md) |
| 29 | the slot URL, natively and from WSL | [`docs/slot-url.md`](docs/slot-url.md) |
| 31 | the reset's database step | [`docs/reset-database.md`](docs/reset-database.md) |
| 32 | the health check and dirty detection | [`docs/health.md`](docs/health.md) |
| 33 | starting and stopping a slot, the agent | [`docs/start-stop.md`](docs/start-stop.md) |
| 34 | the per-lease password | [`docs/lease-credentials.md`](docs/lease-credentials.md) |
| 35, 36, 52 | the whole lease cycle on the host, per flavor | [`docs/e2e-12sp9.md`](docs/e2e-12sp9.md), [`docs/e2e-23.md`](docs/e2e-23.md), [`docs/e2e-35.md`](docs/e2e-35.md) |
| 37 | the v1 pool, its disk and RAM | [`docs/pool.md`](docs/pool.md) |
| 38 | three leases at once, races, a killed broker | [`docs/capacity.md`](docs/capacity.md) |
| 39 | bootstrap: a database restore | [`docs/restore.md`](docs/restore.md) |
| 40 | bootstrap: code deploys | [`docs/code-deploy.md`](docs/code-deploy.md) |
| 41 | bootstrap: package imports | [`docs/import.md`](docs/import.md) |
| 42 | bootstrap recipes | [`docs/bootstrap.md`](docs/bootstrap.md) |
| 43 | taking things out of a lease | [`docs/extract.md`](docs/extract.md) |
| 44, 55 | host settings, the operator's choice | [`docs/host-tuning.md`](docs/host-tuning.md) |
| 48 | the worker guide and the operator runbook | [`docs/using-a-lease.md`](docs/using-a-lease.md), [`docs/runbook.md`](docs/runbook.md) |
| 49 | teardown and uninstall | [`docs/teardown.md`](docs/teardown.md) |
| 51 | the v1 sign-off record: what exists, the evidence, what is left out | [`docs/v1-readiness.md`](docs/v1-readiness.md) |
| 53 | bootstrap: a git baseline of the tree | [`docs/git-baseline.md`](docs/git-baseline.md) |
| ahwin | arashouse on Windows natively, the WSL launcher, build ids, a vendored copy, moving the state to Windows | [`docs/windows-native.md`](docs/windows-native.md) |

Tickets 45 to 47 (libs-js on leases) live in the import-export-libs-js repo.
