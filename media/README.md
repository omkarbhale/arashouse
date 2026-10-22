# media

Aras installers and OOTB backups for each flavor (`12sp9`, `23`, `35`) live here, in `media/<flavor>/`:
`InnovatorSetup.msi`, `Core*.bak`, CD-image zips.

Everything under `media/` except this file is ignored by git. Never commit installers, backups or licence files.

The folder that holds the real files is the **main checkout's** `media/`, not a treehouse worktree's, because a worktree is discarded at teardown.
The CLI resolves it from the main checkout (`git rev-parse --git-common-dir`, its parent); set `ARASHOUSE_MEDIA` to override.
