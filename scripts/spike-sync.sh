#!/usr/bin/env bash
# Copy spike/ to /mnt/c/aras_installations/spike/ so the captain can run the PowerShell scripts from a local Windows path,
# and optionally unpack a flavor's CD image zip into /mnt/c/aras_installations/staging/<flavor>/cd/.
#
#   scripts/spike-sync.sh                 sync the scripts (never touches out/, golden-build/ or any slot)
#   scripts/spike-sync.sh --media 12sp9   also unpack the installer, backups and small utilities from the main checkout's media/12sp9/
#   scripts/spike-sync.sh --results       print the non-secret result files under spike/out/
#
# The Windows folders are created once by the captain's elevated 01-init-folders.ps1, which also grants this user modify on
# spike\ and staging\. Until then this script prints the command to run instead of copying.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
win_root="${ARASHOUSE_SPIKE_WIN_ROOT:-/mnt/c/aras_installations}"
media_flavor=""
show_results=0

while [ $# -gt 0 ]; do
  case "$1" in
    --media) media_flavor="${2:?--media needs a flavor: 12sp9, 23 or 35}"; shift 2 ;;
    --results) show_results=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ "$show_results" = 1 ]; then
  ls -1 "$win_root/spike/out/" 2>/dev/null || { echo "no results yet: $win_root/spike/out/ does not exist" >&2; exit 1; }
  exit 0
fi

if [ ! -d "$win_root/spike" ]; then
  unc="$(wslpath -w "$repo/spike/01-init-folders.ps1")"
  echo "C:\\aras_installations\\spike does not exist yet. The captain runs this once in an elevated PowerShell:" >&2
  echo "  powershell -ExecutionPolicy Bypass -File \"$unc\" -Apply" >&2
  echo "(drop -Apply first to see what it would do)" >&2
  exit 1
fi

# --delete is limited to scripts: out/ and the spike's working folders are excluded and so protected from deletion.
rsync -a --delete \
  --exclude 'out/' --exclude 'golden-build/' --exclude 'slot-*/' --exclude 'measure-*/' --exclude 'vaults/' \
  --exclude 'sqldata/' --exclude 'golden-test/' --exclude 'logs/' --exclude 'empty-*/' --exclude 'handoff/' \
  "$repo/spike/" "$win_root/spike/"
echo "synced spike/ to C:\\aras_installations\\spike\\"

if [ -n "$media_flavor" ]; then
  case "$media_flavor" in 12sp9|23|35) ;; *) echo "unknown flavor: $media_flavor" >&2; exit 64 ;; esac
  main="$(cd "$(git -C "$repo" rev-parse --git-common-dir)/.." && pwd)"
  media="${ARASHOUSE_MEDIA:-$main/media}/$media_flavor"
  dest="$win_root/staging/$media_flavor"
  shopt -s nullglob
  zips=("$media"/*.zip)
  msis=("$media"/InnovatorSetup.msi)
  mkdir -p "$dest"
  if [ ${#zips[@]} -gt 0 ]; then
    # Only what the spike needs, not the 1 GB of documentation. Windows tar.exe does the unpacking (WSL has no unzip). The 12 SP9 image
    # on the source drive is cut short in its last entries (no central directory, tar.exe exits 1 after the early entries are out), so
    # a non-zero exit is not fatal here: every extracted file's size is checked against the archive listing instead.
    cd_dir="$dest/cd"
    mkdir -p "$cd_dir"
    for zip in "${zips[@]}"; do
      zip_win="$(wslpath -w "$zip")"
      list="$(mktemp)"
      trap 'rm -f "$list"' EXIT
      tar.exe -tvf "$zip_win" >"$list" 2>/dev/null || echo "note: $(basename "$zip") lists with errors (a truncated archive); checking sizes below" >&2
      tar.exe -xf "$zip_win" -C "$(wslpath -w "$cd_dir")" 'InnovatorSetup.msi' 'Core*.bak' 'CoreAndSolutions*.bak' 'Utilities/*.exe' 'Utilities/*.sql' 2>/dev/null \
        || echo "note: tar.exe exited non-zero for $(basename "$zip"); verifying the extracted files against the listing" >&2
      bad=0; checked=0
      for want in InnovatorSetup.msi; do
        [ -f "$cd_dir/$want" ] || { echo "MISSING after extraction: $want" >&2; bad=1; }
      done
      # bsdtar -tv: perms links owner group size date time name
      while read -r size name; do
        case "$name" in InnovatorSetup.msi|Core*.bak|CoreAndSolutions*.bak|Utilities/*.exe|Utilities/*.sql) ;; *) continue ;; esac
        checked=$((checked + 1))
        have="$(stat -c %s "$cd_dir/$name" 2>/dev/null || echo missing)"
        if [ "$have" != "$size" ]; then echo "SIZE MISMATCH: $name is $have, the archive lists $size" >&2; bad=1; fi
      done < <(tr -d "\r" <"$list" | awk '{ n=$0; sub(/^([^ ]+ +){5}[^ ]+ +[^ ]+ +[^ ]+ +/, "", n); print $5, n }')
      [ "$checked" -gt 0 ] || { echo "the archive listing had none of the wanted files; cannot verify" >&2; bad=1; }
      [ "$bad" = 0 ] || { echo "extraction from $(basename "$zip") is incomplete; not usable" >&2; exit 1; }
      rm -f "$list"; trap - EXIT
    done
    echo "unpacked installer media to C:\\aras_installations\\staging\\$media_flavor\\cd\\ ($checked files, sizes match the archive listing)"
  elif [ ${#msis[@]} -gt 0 ]; then
    rsync -a --info=progress2 "${msis[@]}" "$dest/"
    echo "copied InnovatorSetup.msi to C:\\aras_installations\\staging\\$media_flavor\\"
  else
    echo "nothing to copy in $media" >&2; exit 1
  fi
fi

echo
echo "Windows path of the scripts: $(wslpath -w "$win_root/spike" 2>/dev/null || echo 'C:\aras_installations\spike')"
