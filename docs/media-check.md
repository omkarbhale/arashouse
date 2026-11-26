# Media check

`arashouse media check [<flavor>...] [--json] [--write-sums]` (ticket 18) catches a wrong, missing or damaged installer before an elevated sitting is spent on it. It is read-only and needs no administrator rights. Exit code 0 means every named flavor is fine, 1 means a problem was found, 2 means bad usage.

## What it checks, per flavor

- **Files.** `InnovatorSetup.msi`, the `Core*.bak` and the `CoreAndSolutions*.bak` named by the flavor registry. Each is found loose in `media/<flavor>/` or, failing that, as a top-level entry of a `*.zip` in the same folder (the CD image). A missing file is reported by its exact loose path.
- **Zip integrity.** Entries read from a zip are inflated and compared with their CRC-32 (the MSI when it is unpacked for reading, the backups in place). A zip with no central directory is read through its local file headers and reported as damaged at source.
- **Checksums.** `media/<flavor>/SHA256SUMS`, else the entries of the shared `media/SHA256SUMS` that start with `<flavor>/`. A mismatch, a listed file that is gone, or a checksum file with no lines in sha256sum format is a problem; no checksum file is a warning. `--write-sums` creates `media/<flavor>/SHA256SUMS` from the files in the folder and never replaces an existing one; a flavor it cannot write for (no folder, or a sums file already there) is reported, the other flavors carry on, the check still runs, and the exit code is 1.
- **MSI Property table.** Read through the Windows Installer COM object by `powershell.exe`. Only `ProductName`, `Manufacturer` and `ProductVersion` are read as values; every other property is read as a name only, inside PowerShell, so a licence or password value never leaves it. `ProductVersion` must equal the registry's `msiProductVersion` or start with it and a dot.
- **Public property names.** The upper-case names (`WEBALIAS`, `INSTALL_DATABASE`, `LICENSEKEY`, ...) that `msiexec NAME=value` takes. With two flavors named, the names present in one MSI and not the other are listed. `missingProperties()` in `src/core/media-check.ts` is what the baseline builder (ticket 24) calls to refuse an unattended command that uses a property the MSI lacks.

An MSI inside a zip is unpacked to the Windows temp folder, because Windows Installer cannot open a database over `\\wsl.localhost\`; an MSI loose on the WSL filesystem (media named by a WSL path, read through `\\wsl.localhost\`) is copied there for the read. The copy is removed afterwards.

The media folder is `ARASHOUSE_MEDIA`, else `config.json`'s `"media"`, else the arashouse checkout's `media/`: its main checkout's, and only when that checkout is arashouse's, never another repository's (`src/core/media.ts`). From WSL that checkout is the one the launcher runs from: the launcher hands its `media/` to the Windows build as `ARASHOUSE_CHECKOUT_MEDIA`, read through `\\wsl.localhost\`, so nothing needs setting. A copy outside a checkout (vendored) needs one of the first two; without them the check fails with a message that names them.

## The 12 SP9 limitation

`ProductVersion` of the 12.0 MSI reads `12.0.0` whatever the service pack, so for `12sp9` the check passes on `12.0.x`. The build is confirmed after the first install by `Aras.Server.Core.dll` = 12.0.0.24090 (ticket 24 records it). The report carries this as a note.

## Run against the captain's real files, 2026-10-22

The media are CD-image zips copied from `I:\ARAS\ARAS Installables\ARAS Versions` into the main checkout's `media/<flavor>/`. All three flavors pass; a full run of all three takes about a minute (it hashes about 3 GB of zips and unpacks three MSIs of 355 to 558 MB).

| flavor | zip | MSI `ProductVersion` | public property names | notes |
|---|---|---|---|---|
| `12sp9` | `12.0 SP9 CD Image.zip` | 12.0.0 (passes `12.0.x`) | 92 | **no central directory**: damaged at source, 1429 entries read from the local headers; the MSI and both `Core120` backups pass their CRC-32 |
| `23` | `Release 23 CD Image.zip` | 14.0.9 | 93 | |
| `35` | `Release 35 CD Image.zip` | 14.35.0 | 93 | the registry's `msiProductVersion` for `35` is `14.35`, confirmed by this read; the backups are named `Core140.bak` and `CoreAndSolutions140.bak` |

The names present in one MSI and not the other: `12sp9` against `23` differ by one, `SQL_ADO_CONN_DRIVER`, which only the 14.x MSIs support. `ProductName` is `Aras Innovator` and `Manufacturer` is `Aras Corporation` in all three. All three zips match the shared `media/SHA256SUMS`.

The ticket expected `35` to read as missing; the Release 35 CD image arrived afterwards, so it passes.

## For later tickets

- Ticket 24 (baseline builder) needs the MSI and backups out of the zip. `extractZipEntry` in `src/core/zip.ts` does that with the CRC-32 check; `checkMedia` is its pre-flight.
- The 12 SP9 zip being damaged at source means any other tool that opens it by its central directory (Explorer, `unzip`, Python's `zipfile`) fails on it; use `listZip`.
