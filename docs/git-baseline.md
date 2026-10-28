# A git baseline of the leased code tree: `get --git` and `git-baseline`

Ticket 53, a bootstrap step after the code deploys (ticket 40) and the imports (ticket 41). The captain's words:

> "Maybe even initial commit in the provided codetree." "Add it now."
> "Aras has many volatile things in the codetree, we should ignore them ideally. And references to which database to
> use and so on are also in the codetree. Make the choices properly when it comes to that."

The holder gets a git repository in the leased slot's `Innovator\` tree whose one commit is the tree exactly as
handed over, so `git status` and `git diff` show only what changed after. It belongs to the lease: it has no remote,
is never pushed, and the next reset removes it.

Sources: `src/core/git-baseline.ts` (the ignore rules per flavor, the guards, the commit's identity and settings),
`src/cli/git.ts` (building, staging, recording).

## Using it

```
arashouse get 23 --holder my-task --json --code ./build/client --git    # the baseline last, after the code
arashouse git-baseline --lease <lease_id>                              # on a lease already held
```

Then, from WSL, with Git for Windows (fast: it reads the tree natively; the repository is the broker's, so the worker
names it safe):

```
git.exe -c safe.directory='*' -C 'C:\aras_installations\slots\23\01\Innovator' status
git.exe -c safe.directory='*' -C 'C:\aras_installations\slots\23\01\Innovator' diff > my-change.patch
```

WSL's own git works too, read-only, on `/mnt/c/aras_installations/slots/23/01/Innovator`, but every `status` walks the
tree through `/mnt/c` (half a minute for `12sp9`). The worker can only read `slots\`, so neither can commit there: the
holder changes the tree with `deploy-code` and takes the diff out (`docs/extract.md`) before returning the lease.

- `get --git --json` adds `bootstrap.git`, and `git-baseline --json` prints `{ slot, git }`
  (`docs/schemas/git-baseline.schema.json`): `{ ok, commit, files, path, detail }`.
- The lease record gets `git: <commit>` (`status --json`), and `events.log` a `bootstrap` event.
- `get --atomic`: a baseline that fails returns the lease, as a failed deploy does.

Exit codes (`docs/cli.md`): 7 when refused, nothing changed (the lease or its tree already has a repository, a `--code`
source writes `Innovator\.git\` or `Innovator\.gitignore`, or the commit would hold a secret); 10 when it failed after
that, the lease still held; 4 for `git-baseline` on a lease that is not held. `get --git` checks that git can run, and
that no `--code` writes the repository's place, before it takes the lease.

## What the repository holds

The commit is everything under `Innovator\` except what the generated `.gitignore` leaves out; the `.gitignore` is
committed too. Its rules are data, per flavor (`ignoreRules` in `src/core/git-baseline.ts`), tested with git's own
matching (`src/core/git-baseline.test.ts`). Patterns are relative to `Innovator\`, matched case-insensitively.

**Secrets and identity files: never committed.** Before the commit, every staged path is checked, and one of these
refuses the commit (nothing is deployed):

| rule | why |
|---|---|
| `InnovatorServerConfig.xml`, `*.pfx`, `*.cer`, `key-*.xml`, `vault.config`, anywhere | ticket 40's protected list: the licence and SQL logins, certificates and their keys, ASP.NET Core data-protection keys, the vault's config |
| `/Server/App_Data/Certificates/` | the server's OAuth client certificate and the OAuth server's certificate the reset renders |
| `/Server/OAuth.config` | names the server's certificate and holds its password |
| `/Client/App_Data/Certificates/`, `/Client/OAuth.ClientServer.config` (`35` only) | 14.35's client server is an OAuth client too, with the same pair |

So a holder's own `.gitignore` deeper in the tree that un-ignores one of them still cannot get it committed.

**Files that tie the tree to the slot.** Inside `Innovator\`, only the two `Innovator.xml` files name anything of the
slot: each holds one `<ConfigFilePath>`, the slot's own `InnovatorServerConfig.xml`, which the edit list renders
(`docs/edits.md`). Both are ignored, so no diff shows slot plumbing and no commit ties code to one slot. The database,
logins, licence, URLs and the vault are in `InnovatorServerConfig.xml`, `OAuthServer\`, `VaultServer\` and the
SelfServiceReporting files, all outside `Innovator\`, so outside the repository.

The `web.config` files (`Innovator\`, `Client\`, `Server\`) are committed: they are golden's in every slot (no slot
value is rendered into them), they hold no secret (the passwords in `Server\web.config` are the MSI's `{password}`
placeholders, the same in every install), and they are what a developer genuinely edits (handlers, app settings). The
same holds for 14.x's `appsettings.json` and `InnovatorServer.config`.

**Files the server writes while it runs.** The runtime folders the golden manifest leaves out and the reset empties
(`/Server/temp/`, `/Server/dll/`, `/Server/logs/`), the client's bundle index `/Client/jsBundles/data.json`, and
`/Client/jsBundles/compile.log`, which the client rewrites each time it starts. The data-protection keys the 14.x
client and server write are `key-*.xml`, above.

## How it is made

git runs as the worker, never as the broker:

1. **Checks.** The lease must not have a baseline yet, and the slot's `Innovator\` must have no `.git` or `.gitignore`.
2. **Build**, with Git for Windows (`/mnt/c/Program Files/Git/cmd/git.exe`, or `ARASHOUSE_WINDOWS_GIT`) through interop:
   reading the tree through `/mnt/c` from WSL runs at under 1 MB/s on the host (`12sp9`'s `Client\` alone took 11
   minutes), git.exe reads it natively with the worker's read grant on `slots\`. No system or user git config is read
   (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=NUL`), so the worker's own settings do not leak in. In
   `<root>\staging\<lease_id>\code\<n>`, with the slot's `Innovator\` as the work tree: `git init` (no template: no
   hooks), the repository's settings (below), `add --all` with the generated file as the excludes file, the
   `.gitignore` added, the staged paths checked, one commit on `main` with the message `arashouse baseline <flavor>
   <lease_id>` by `arashouse <arashouse@localhost>`, and the objects repacked into one pack without deltas (seconds; with
   deltas it was 50 s for `12sp9`), so the broker copies a handful of files rather than one per object.
3. **Place.** The broker's `deployCode` (ticket 40) puts `.git\` and `.gitignore` into `Innovator\`, with every guard
   it has for what the worker stages (the stamp names the lease, no link or junction, each file copied from a checked
   handle). It quiesces, copies, and starts and warms the slot, so the slot has recycled and restarted once by the time
   `get` answers. A deploy that writes nothing ASP.NET compiles clears no compiled files.
4. **Record** `git: <commit>` on the lease. The staged folder is removed in every case.

The repository's settings, so git on Windows and git in WSL read the one index alike: `core.filemode=false`,
`core.symlinks=false`, `core.ignorecase=true`, `core.autocrlf=false` (the bytes as they are, CRLF and all),
`core.checkStat=minimal` and `core.trustctime=false` (Git for Windows records no inode, device or owner, and WSL sees
them; comparing size and whole-second mtime keeps either from reading every file again), `core.logAllRefUpdates=false`,
`gc.auto=0`.

IIS serves none of it: nothing in `.git\` has an extension IIS has a MIME type for, and neither has `.gitignore`.

## After `return`

The reset's tree step mirrors golden over the slot (`robocopy /MIR`, `docs/reset.md`): `.git\` and `.gitignore` are
not in golden, so they are removed, and its `fast` verify proves the tree is golden's again. Anything the holder wants
from the history (a diff, a patch) it takes out first.

## Measured on the host

**What an untouched slot changes.** A stat snapshot (path, size, mtime; no content) of a `12sp9` lease's `Innovator\`
right after `get`, then after its pages were read, root logged in and items were read (ItemType, User, Method, Form
with its Body), after a recycle and restart (`deploy-code`: pools and agent stopped and started), after the same again,
and after a second restart (2026-10-28, `12sp9-01`): the only files that changed were `Client/jsBundles/compile.log`
(rewritten at each start) and `Server/temp/<day>.log`. Both are ignored. Before that lease, the newest files of every
free slot of each flavor were the ones the reset renders or golden carries: the two `Innovator.xml`, the OAuth server's
`.cer`, `compile.log`, and for 14.x the `key-*.xml` of `Client\App_Data` and `Server\App_Data`; all are ignored.
