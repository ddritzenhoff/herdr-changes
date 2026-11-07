#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DEST=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
UPDATE=false
case "${1:-}" in
  '') ;;
  --update) UPDATE=true ;;
  *) printf '%s\n' 'Usage: sh scripts/install.sh [--update]' >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then printf '%s\n' 'Too many arguments' >&2; exit 2; fi
for tool in cargo git difft herdr-app tar; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Required program not found: %s\n' "$tool" >&2; exit 1; }
done
mkdir -p "$DEST"
DEST=$(CDPATH='' cd -- "$DEST" && pwd)
if [ "$ROOT" = "$DEST" ]; then printf '%s\n' 'Source and installation directories must differ.' >&2; exit 1; fi
for component in mods/review mods/review-tabs tools/review-backend; do
  if [ -e "$DEST/$component" ] || [ -L "$DEST/$component" ]; then
    if [ "$UPDATE" != true ]; then
      printf 'Already exists: %s\nUse --update to back it up and replace it.\n' "$DEST/$component" >&2
      exit 1
    fi
  fi
done
STAGE=$(mktemp -d "$DEST/.changes-install.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
# Export source/assets only: no development build caches or generated helpers.
tar -C "$ROOT" --exclude='*/target' --exclude='*/target/*' --exclude='*.d.ts' --exclude='jsconfig.json' --exclude='node_modules' \
  -cf "$STAGE/source.tar" mods/review mods/review-tabs tools/review-backend
tar -xf "$STAGE/source.tar" -C "$STAGE"
rm "$STAGE/source.tar"
sh "$STAGE/tools/review-backend/build.sh"
herdr-app check "$STAGE/mods/review"
herdr-app check "$STAGE/mods/review-tabs"
BACKUP="$DEST/data/changes-install-backups/$(date +%Y%m%d-%H%M%S)-$$"
for component in mods/review mods/review-tabs tools/review-backend; do
  if [ -e "$DEST/$component" ] || [ -L "$DEST/$component" ]; then
    mkdir -p "$BACKUP/$(dirname "$component")"
    mv "$DEST/$component" "$BACKUP/$component"
  fi
  mkdir -p "$DEST/$(dirname "$component")"
  mv "$STAGE/$component" "$DEST/$component"
done
printf '\nInstalled Changes in %s\n' "$DEST"
if [ -d "$BACKUP" ]; then printf 'Previous components: %s\n' "$BACKUP"; fi
printf '%s\n' 'Next: wire review-tabs into your personal layout and merge the shortcut from keys.json.'
printf '%s\n' 'See README.md. Your layout, shortcuts, drafts and terminal state were not changed.'
