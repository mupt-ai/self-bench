#!/bin/sh
# Install the SelfBench CLI from its GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/mupt-ai/self-bench/main/scripts/install-cli.sh | sh
#
# Needs Node.js 22 or later. The newest cli-v* release is installed unless
# SELFBENCH_CLI_VERSION names one (for example 0.3.15). Set SELFBENCH_INSTALL_DIR
# to change where the command goes (default: $HOME/.local/bin). Re-run to upgrade.
set -eu

REPO="mupt-ai/self-bench"
REQUIRED_NODE_MAJOR=22
INSTALL_DIR="${SELFBENCH_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js $REQUIRED_NODE_MAJOR or later is required. Install it from https://nodejs.org and rerun."
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v shasum >/dev/null 2>&1 || die "shasum is required (it ships with macOS and Perl)."

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt "$REQUIRED_NODE_MAJOR" ]; then
  die "Node.js $REQUIRED_NODE_MAJOR or later is required; found $(node -v)."
fi

if [ -n "${SELFBENCH_CLI_VERSION:-}" ]; then
  tag="cli-v$SELFBENCH_CLI_VERSION"
else
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" \
    | grep -o '"tag_name": *"cli-v[^"]*"' | head -1 | sed 's/.*"\(cli-v[^"]*\)"/\1/')
  [ -n "$tag" ] || die "no SelfBench CLI release found on GitHub."
fi

base="https://github.com/$REPO/releases/download/$tag"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "Downloading self-bench ($tag) ..."
curl -fsSL -o "$tmp/self-bench" "$base/self-bench.js" \
  || die "could not download $base/self-bench.js"
curl -fsSL -o "$tmp/self-bench.sha256" "$base/self-bench.js.sha256" \
  || die "could not download the checksum for $tag."

# The checksum file names self-bench.js, so verify against a copy with that name.
mv "$tmp/self-bench" "$tmp/self-bench.js"
(cd "$tmp" && shasum -a 256 -c self-bench.sha256 >/dev/null) \
  || die "checksum mismatch for $tag; nothing was installed."

mkdir -p "$INSTALL_DIR"
mv "$tmp/self-bench.js" "$INSTALL_DIR/self-bench"
chmod +x "$INSTALL_DIR/self-bench"

# Guard against a build without sign-in.
help_output=$("$INSTALL_DIR/self-bench" help 2>&1) || die "installed self-bench failed to run: $help_output"
case "$help_output" in
  *"self-bench login"*) ;;
  *) die "the installed build ($tag) has no sign-in command." ;;
esac

say "self-bench installed to $INSTALL_DIR/self-bench"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) say "Add $INSTALL_DIR to your PATH to run it by name." ;;
esac
say ""
say "Next steps:"
say "  self-bench login     sign in through your browser and pick a workspace"
say "  self-bench help      list every command"
