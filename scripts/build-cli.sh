#!/bin/sh
# Build the single-file SelfBench CLI that the curl installer downloads.
# Output: dist/cli/self-bench.js (run with Node.js 22+) and its SHA-256 file.
set -eu

cd "$(dirname "$0")/.."
out_dir=dist/cli
rm -rf "$out_dir"
mkdir -p "$out_dir"

bun build src/api/cli/bin.ts --target node --outfile "$out_dir/self-bench.js" >/dev/null
chmod +x "$out_dir/self-bench.js"

(cd "$out_dir" && shasum -a 256 self-bench.js > self-bench.js.sha256)
echo "built $out_dir/self-bench.js"
