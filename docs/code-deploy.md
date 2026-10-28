# Code-tree deployment onto a lease: `get --code` and `deploy-code`

Ticket 40, the second bootstrap step (after the database restore, ticket 39; before the imports, ticket 41; tied
together by the recipe, ticket 42). The captain's words:

> "One more feature that I want is some kind of automation to get the Aras going. Perhaps a optional database
> restore, followed by import/codetree deployments. This is similar to worktree in that sense."
> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever took the lease
> before giving it back."

A deploy puts the caller's code into the leased slot's tree: custom client files, method DLLs, a patched
`Server\bin`, a theme, a whole overlay. It lasts as long as the lease: the next reset's mirror (`robocopy /MIR`,
`docs/reset.md`) removes it, and the golden manifest's `fast` verify proves it is gone.

Sources: `src/core/code-deploy.ts` (the rules, shared), `src/cli/code.ts` (reading, staging, recording),
`src/broker/code-deploy.ts` (the broker's `deployCode` verb), `src/broker/staged-fs.ts` (its reads of the staged
folder).

## Using it

```
arashouse get 12sp9 --holder my-task --json --code ./build/client --code C:\work\methods.zip:Innovator/Server/bin
arashouse deploy-code --lease <lease_id> ./build/client        # onto a lease already held
```

- `--code <dir|zip>[:<subpath>]` is repeatable and applied in order. The source is a folder or a `.zip`, a WSL
  path or a Windows drive path (`C:\...`, read through `/mnt/c`).
- `<subpath>` is where the source's top lands in the slot's tree, `/` or `\` separated, default `Innovator`.
  `.` is the top of the tree itself (where `InnovatorServerConfig.xml` is). The last colon splits it off, except
  a drive's colon.
- A `deploy.json` at the top of the source is honoured and never copied:

  ```json
  { "files": ["Client/scripts/fix.js"], "delete": ["Client/scripts/old.js"] }
  ```

  `files` (optional) limits the copy to the listed source files; without it every file is copied. `delete`
  (optional) lists files to delete from the slot's tree, relative to the subpath like the copies. Nothing else is
  ever deleted: a deploy is an overlay, never a mirror, so every golden file it does not name stays.
- `--allow-servers` lets it write `VaultServer\` and `OAuthServer\` too; `--allow-config` lets it overwrite or
  delete the secrets and identity files (below).
- `get --atomic`: a deploy that fails returns the lease (it is reset, removing what was deployed) and `get` fails.
  Without it, a failed deploy leaves the lease granted with the failure shown, since the holder is mid-development:
  `get` prints the lease as usual (the JSON's `bootstrap.code` says what failed) and exits 10.
- `deploy-code --json` prints `{ slot, code }` (`docs/schemas/deploy-code.schema.json`); each entry is
  `{ source, subpath, ok, files, deleted, detail }`, as in `get`'s `bootstrap.code`.

Exit codes (`docs/cli.md`): 7 when a guard refuses (nothing changed; `get` refuses before it takes the lease, since
every source is read and planned first), 10 when a deploy failed after the lease was taken, 4 for `deploy-code` on a
lease that is not held.

## Where it may write

The rules are one function, `planDeploy`, which the CLI runs on the source and the broker runs again on the
staged copy:

- **Inside the slot's tree only.** Every target is a relative path under `<root>\slots\<key>\<NN>`, in
  `Innovator\`, or `VaultServer\` and `OAuthServer\` with `--allow-servers`. Nothing else at the top of the tree
  (not `AgentService\`, not the slot's stamp) can be written.
- **No path tricks.** No source or target path, and no `deploy.json` entry, may have `..`, `.`, an empty segment,
  a drive or any colon (so no alternate data stream), a segment ending in a dot or a space (Windows drops them, so
  `InnovatorServerConfig.xml.` is that file), an 8.3 short name (`INNOVA~1.XML`) or a device name. Two source
  files that differ only in case are refused (Windows would make them one).
- **No links.** A symbolic link or junction anywhere in the source is refused by the CLI (WSL shows a junction as a
  symbolic link); one anywhere in the staged copy, or in the folders above it in `staging\`, is refused by the
  broker; and no folder on a target's way inside the slot's tree may be a link, a junction or a file. These are
  checked before the slot is quiesced, and again after (when nothing of the slot runs any more).
- **Secrets and identity files** need `--allow-config`, wherever they are: `InnovatorServerConfig.xml`, `*.pfx`,
  `*.cer`, `key-*.xml`, `vault.config`. These are what the edit list renders from the host's store (licence, SQL
  logins; ticket 19, `docs/edits.md`). With `--allow-config`, `InnovatorServerConfig.xml` may be written at the top
  of the tree (subpath `.`); the slot then carries the caller's file, and the next reset renders the slot's own
  again.
- The deny-list's substring rule (`olm`, `prod`) is for the names of the things the tool owns, not the files inside
  a slot's tree: a client file named `products.js` deploys.

## How it runs

1. **Plan, before anything.** The CLI reads each source (a folder walked without following links, or a zip's
   central directory; a damaged zip is refused) and its `deploy.json`, and plans it. A refusal exits 7 before
   `get` takes a lease or anything is staged.
2. **Stage.** Into `<root>\staging\<lease_id>\code\<n>\` (`/mnt/c/aras_installations/staging/...`; the worker may
   change `staging\`, ticket 21): only the planned files, and the `deploy.json`. The CLI hashes each file as it
   stages it.
3. **Apply** (the broker's `deployCode`, under the slot's lock):
   1. the slot's stamp must name the caller's lease (`get` writes it), so a stale caller cannot deploy into a later
      lease of the slot; the staged folder must be exactly `staging\<that lease>\code\<n>`;
   2. the staged tree walked, its `deploy.json` read, the deploy planned again, the targets checked;
   3. **quiesce**: the slot's agent and pools stopped and its processes waited for (the reset's `quiesce`,
      ticket 30);
   4. the targets checked again; the `delete` list applied (a file only; one that is not there is not counted);
      the files copied;
   5. when the deploy touched `Innovator\Server\bin` or `Innovator\Server\dll`, ASP.NET's temporary files of the
      alias cleared (`slot-steps.ps1 -Step clear-aspnet`), so nothing compiled from the old binaries is served;
   6. **start and warm** (`startSlot`, ticket 33): the pools started again (a recycle), the agent too when the lease
      was taken with `--agent` (recorded on the lease as `agent: true`), and `Client/`, `Server/DBList.aspx` and the
      OAuth discovery document requested from the slot's own server. One that does not answer makes the result
      `ok: false`: the files are in place, the slot did not come back up.

   A failure after the quiesce starts the slot again before it is answered, so a failed deploy does not leave the
   holder with a stopped slot. The staged folder is deleted in every case, by the broker (each link or junction in it removed itself, never followed) and by the CLI.
4. **Record.** The lease's `bootstrap` record in `state.json` gets `code: "<n> files, manifest <hash>"` and
   `code_deploys: <k>`, an event `bootstrap` in `events.log` naming the keys: the file count and a SHA-256 over the targets and each file's SHA-256 (and the deletes),
   chained over the deploys in order. No path or content is recorded.

**Why the health check is the warm-up.** Ticket 32's full health check is the clean-slot check: it requires a stamp
with no lease and a tree that matches golden, which a leased slot with deployed code never has, by design. After a
deploy, what the holder needs to know is whether the slot serves again; the start's warm-up of the three
applications is that check. The full check runs, as always, after the reset.

**The staged folder is the worker's.** The broker runs as a local administrator and the worker may change
`staging\` while the broker reads it, so a swapped-in junction or hard link could point the broker at a file the
worker cannot read (a DPAPI blob in `secrets\`, say) and have it copied into the slot, which the worker can read.
So the broker never opens a staged file by name alone: it looks at it without following a link (a plain file with
one link), opens it, and the open handle must be that same file (device and file id); anything else is refused. It
writes each target through a temporary file renamed over it, so a hard link the leaseholder's server code left in
the slot's tree is replaced rather than written through.

## After `return`

Nothing about a deploy survives the lease. `return` marks the slot dirty; the reset's tree step mirrors golden over
the slot (`/MIR` removes the added files and restores the replaced ones), empties `Server\dll`, `Server\temp` and the
other runtime folders, clears ASP.NET's temporary files of the alias, renders the configs again and verifies the tree
at `fast` (`docs/reset.md`). Anything the holder wants to keep, it takes out before returning (ticket 43).
