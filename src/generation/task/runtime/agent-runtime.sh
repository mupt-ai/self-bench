#!/bin/sh
# Harness-neutral solver runtime, installed right after FROM so tasks on one base image share it.
# Adds only missing tools (never upgrading the task's packages) and a Node kept off PATH, so the
# repository keeps its own Node. harbor_gateway.py installs each harness CLI onto this Node.
set -eu
NODE_VERSION=22.23.3
ROOT=/opt/selfbench-agent-runtime

missing=""
for tool in bash curl git; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
[ -s /etc/ssl/certs/ca-certificates.crt ] || missing="$missing ca-certificates"

# ripgrep is best-effort: Codex and Claude Code bundle their own.
if command -v apt-get >/dev/null 2>&1; then
  libc=glibc
  if [ -n "$missing" ] || ! command -v rg >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    [ -z "$missing" ] || apt-get install -y --no-install-recommends $missing
    command -v rg >/dev/null 2>&1 || apt-get install -y --no-install-recommends ripgrep \
      || echo "selfbench: ripgrep is unavailable on this base image" >&2
  fi
elif command -v apk >/dev/null 2>&1; then
  libc=musl
  apk add --no-cache $missing libgcc libstdc++
  command -v rg >/dev/null 2>&1 || apk add --no-cache ripgrep \
    || echo "selfbench: ripgrep is unavailable on this base image" >&2
else
  echo "selfbench: the agent runtime needs an apt-get (Debian/Ubuntu) or apk (Alpine) base image" >&2
  exit 1
fi

case "$(uname -m)-$libc" in
  x86_64-glibc) name=linux-x64 sha=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af ;;
  aarch64-glibc) name=linux-arm64 sha=5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2 ;;
  x86_64-musl) name=linux-x64-musl sha=5ea46894fc06e09363846d8ed65a822bd00bea35d974e41320272a48af309e3a ;;
  aarch64-musl) name=linux-arm64-musl sha=8cec03a498d883739d1dc9b924fda2f86944705b54ac707bf48a637483774c70 ;;
  *) echo "selfbench: no agent Node runtime for $(uname -m) ($libc)" >&2; exit 1 ;;
esac
name="node-v$NODE_VERSION-$name"
if [ "$libc" = musl ]; then
  url="https://unofficial-builds.nodejs.org/download/release/v$NODE_VERSION/$name.tar.gz"
else
  url="https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz"
fi

work="$(mktemp -d)"
curl -fsSL --retry 3 -o "$work/node.tar.gz" "$url"
echo "$sha  $work/node.tar.gz" | sha256sum -c -
tar -xzf "$work/node.tar.gz" -C "$work"
mkdir -p "$ROOT"
mv "$work/$name" "$ROOT/node"
rm -rf "$work"
# Node 22 needs glibc 2.28. Without the runtime, trials fall back to Harbor's own install.
if ! "$ROOT/node/bin/node" --version; then
  rm -rf "$ROOT/node"
  echo "selfbench: Node $NODE_VERSION does not run on this base image; trials will install their own" >&2
fi
