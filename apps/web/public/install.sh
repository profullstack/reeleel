#!/bin/sh
# Install reeleel, the ReelEel command line (npm: @profullstack/reeleel).
#
#   curl -fsSL https://reeleel.com/install.sh | sh
#
# Uses bun if present, otherwise npm (Node >= 22.5). When the global npm prefix
# is not writable it installs into ~/.local instead of asking for sudo.
# Re-running it upgrades to the latest version.
set -eu

PKG="@profullstack/reeleel"

say() { printf '%s\n' "$*"; }
die() { printf 'reeleel install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

say "Installing reeleel (ReelEel command line)..."

if have bun; then
  # Without a package.json of its own, bun add -g writes into the nearest one
  # above ~/.bun/install/global, which can be some unrelated project's.
  BUN_GLOBAL="${BUN_INSTALL:-$HOME/.bun}/install/global"
  mkdir -p "$BUN_GLOBAL"
  [ -f "$BUN_GLOBAL/package.json" ] || printf '{}\n' > "$BUN_GLOBAL/package.json"
  bun add -g "$PKG@latest"
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
elif have npm && have node; then
  ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=5)?1:0)' 2>/dev/null || echo 0)
  [ "$ok" = 1 ] || die "Node >= 22.5 required (found $(node -v)). Upgrade Node or install bun: https://bun.sh"
  prefix=$(npm config get prefix)
  modules="$prefix/lib/node_modules"
  [ -d "$modules" ] || modules="$prefix/lib"
  if [ -w "$modules" ] && [ -w "$prefix/bin" ]; then
    npm install -g "$PKG@latest"
    BIN_DIR="$prefix/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    say "npm prefix $prefix is not writable; installing into $HOME/.local"
    npm install -g --prefix "$HOME/.local" "$PKG@latest"
  fi
else
  die "needs bun (https://bun.sh) or Node >= 22.5 with npm (https://nodejs.org)"
fi

say ""
if have reeleel; then
  say "reeleel $(reeleel --version 2>/dev/null || echo) installed."
else
  say "reeleel installed to $BIN_DIR, which is not on your PATH. Add it:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
if ! have ffmpeg || ! have ffprobe; then
  say ""
  say "ReelEel also needs FFmpeg and ffprobe on your PATH (https://ffmpeg.org/download.html)."
fi
say ""
say "Next:"
say "  reeleel doctor                                   # check FFmpeg, disk, CV worker"
say "  reeleel project create \"Spring Cup\" --sport soccer"
say "  reeleel --help                                   # every command"
say "Docs: https://github.com/profullstack/reeleel/blob/master/docs/cli.md"
