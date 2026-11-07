#!/bin/sh
# Install the SelfBench CLI:
#   curl -fsSL https://selfbench.dev/install-cli.sh | sh
#
# Needs Node.js 22 or later and npm. Set SELFBENCH_CLI_VERSION to pin a version
# (default: latest). Re-running upgrades the CLI in place.
set -eu

REQUIRED_NODE_MAJOR=22
VERSION="${SELFBENCH_CLI_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js $REQUIRED_NODE_MAJOR or later is required. Install it from https://nodejs.org and rerun."
command -v npm >/dev/null 2>&1 || die "npm is required. It ships with Node.js; install Node.js and rerun."

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt "$REQUIRED_NODE_MAJOR" ]; then
  die "Node.js $REQUIRED_NODE_MAJOR or later is required; found $(node -v)."
fi

say "Installing self-bench@$VERSION ..."
npm install -g "self-bench@$VERSION" >/dev/null

# Guard against a stale published build: the CLI must include sign-in.
if ! self-bench help 2>/dev/null | grep -q 'self-bench login'; then
  die "the installed self-bench is too old to sign in. Try SELFBENCH_CLI_VERSION=<newer version>."
fi

say "self-bench installed."
say ""
say "Next steps:"
say "  self-bench login     sign in through your browser and pick a workspace"
say "  self-bench help      list every command"
