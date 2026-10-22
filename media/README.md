# media

Aras installers and OOTB backups for each flavor (`12sp9`, `23`, `35`) live here, in `media/<flavor>/`:
`InnovatorSetup.msi`, `Core*.bak`, CD-image zips.

Everything under `media/` except this file is ignored by git. Never commit installers, backups or licence files.

The folder that holds the real files is the **main checkout's** `media/`, not a treehouse worktree's, because a worktree is discarded at teardown.
The CLI resolves it from the main checkout (`git rev-parse --git-common-dir`, its parent); set `ARASHOUSE_MEDIA` to override.

Each flavor folder holds either the loose files (`InnovatorSetup.msi`, `Core*.bak`, `CoreAndSolutions*.bak`) or the CD-image zip they came in; a loose file wins over the same name inside a zip.
`arashouse media check [<flavor>...]` reports what is missing, verifies `SHA256SUMS` (the one in the flavor folder, else the shared one at the top of `media/`), and reads the MSI's version and property names; `--write-sums` creates a flavor's `SHA256SUMS` once.
