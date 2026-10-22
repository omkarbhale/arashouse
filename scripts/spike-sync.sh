#!/usr/bin/env bash
# Copy spike/ to /mnt/c/aras_installations/spike/ so the captain can run the PowerShell scripts from a local Windows path,
# and optionally copy a flavor's installer zip into /mnt/c/aras_installations/staging/<flavor>/.
#
#   scripts/spike-sync.sh                 sync the scripts (never touches out/, golden-build/ or any slot)
#   scripts/spike-sync.sh --media 12sp9   also copy the CD image zip from the main checkout's media/12sp9/
#   scripts/spike-sync.sh --results       print the non-secret result files under spike/out/
#
# The Windows folders are created once by the captain's elevated 01-init-folders.ps1, which also grants this user modify on
# spike\ and staging\. Until then this script prints the command to run instead of copying.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
win_root="/mnt/c/aras_installations"
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
  --exclude 'sqldata/' --exclude 'golden-test/' --exclude 'logs/' --exclude 'empty-*/' \
  "$repo/spike/" "$win_root/spike/"
echo "synced spike/ to C:\\aras_installations\\spike\\"

if [ -n "$media_flavor" ]; then
  case "$media_flavor" in 12sp9|23|35) ;; *) echo "unknown flavor: $media_flavor" >&2; exit 64 ;; esac
  main="$(cd "$(git -C "$repo" rev-parse --git-common-dir)/.." && pwd)"
  media="${ARASHOUSE_MEDIA:-$main/media}/$media_flavor"
  dest="$win_root/staging/$media_flavor"
  [ -d "$media" ] || { echo "no media folder: $media" >&2; exit 1; }
  mkdir -p "$dest"
  shopt -s nullglob
  zips=("$media"/*.zip "$media"/InnovatorSetup.msi)
  [ ${#zips[@]} -gt 0 ] || { echo "nothing to copy in $media" >&2; exit 1; }
  for f in "${zips[@]}"; do rsync -a --info=progress2 "$f" "$dest/"; done
  echo "copied installer media to C:\\aras_installations\\staging\\$media_flavor\\ (10-baseline-install.ps1 unpacks it)"
fi

echo
echo "Windows path of the scripts: $(wslpath -w "$win_root/spike" 2>/dev/null || echo 'C:\aras_installations\spike')"
