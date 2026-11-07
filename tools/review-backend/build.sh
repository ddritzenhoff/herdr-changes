#!/bin/sh
set -eu
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if ! command -v difft >/dev/null 2>&1; then
  printf '%s\n' 'Install Difftastic 0.72.0 first (macOS: brew install difftastic).' >&2
  exit 1
fi
case "$(difft --version | head -n 1)" in
  'Difftastic 0.72.0') ;;
  *) printf '%s\n' 'Warning: structural JSON is tested only with Difftastic 0.72.0; other versions fall back to text.' >&2 ;;
esac
cargo build --release --locked --manifest-path "$HERE/Cargo.toml"
printf '%s\n' 'Built Agent Review. In your configured Herdr layout, focus an agent and press Cmd+Shift+R.'
