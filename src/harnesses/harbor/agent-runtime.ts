/**
 * The solver agent's toolchain, pinned in one place.
 *
 * A compiled task is reused by evaluations across harnesses and harness versions, so its images
 * carry only the harness-neutral runtime (system tools and a private Node). Each trial
 * still installs its harness CLI, at the version pinned here, onto that runtime; the adapters in
 * runtime/harbor_gateway.py skip Harbor's apt and nvm steps when the runtime is present.
 */

/** Must match RUNTIME_ROOT in runtime/harbor_gateway.py. */
const AGENT_RUNTIME_ROOT = "/opt/selfbench-agent-runtime";

const AGENT_NODE_VERSION = "22.23.3";

/** SHA-256 of each Node tarball, keyed by `<arch>-<libc>`; musl builds come from unofficial-builds. */
const AGENT_NODE_SHA256 = {
  "x64-glibc": "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
  "arm64-glibc": "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2",
  "x64-musl": "5ea46894fc06e09363846d8ed65a822bd00bea35d974e41320272a48af309e3a",
  "arm64-musl": "8cec03a498d883739d1dc9b924fda2f86944705b54ac707bf48a637483774c70",
} as const;

/** Harness CLI versions each trial installs; Harbor would otherwise install @latest. */
export const HARNESS_CLI_VERSIONS = {
  codex: "0.158.0",
  "claude-code": "2.1.284",
  pi: "0.87.1",
} as const;

export function harnessVersionArguments(harness: string): string[] {
  const version = HARNESS_CLI_VERSIONS[harness as keyof typeof HARNESS_CLI_VERSIONS];
  return version ? ["--agent-kwarg", `version=${version}`] : [];
}

/**
 * Root script for the layer right after FROM. It installs only the system tools that are
 * missing (never upgrading the task's own packages) and a Node that stays off PATH, so the
 * repository keeps whatever Node its base image or setup provided.
 */
export function agentRuntimeScript(): string {
  const checksums = Object.entries(AGENT_NODE_SHA256)
    .map(([platform, sha]) => `  ${platform}) sha=${sha} ;;`)
    .join("\n");
  return `#!/bin/sh
set -eu
missing=""
need() {
  command -v "$1" >/dev/null 2>&1 || missing="$missing $2"
}
need bash bash
need curl curl
need git git
need rg ripgrep
[ -s /etc/ssl/certs/ca-certificates.crt ] || missing="$missing ca-certificates"
if command -v apt-get >/dev/null 2>&1; then
  libc=glibc
  if [ -n "$missing" ]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing
  fi
elif command -v apk >/dev/null 2>&1; then
  libc=musl
  apk add --no-cache $missing libgcc libstdc++
else
  echo "selfbench: the agent runtime supports apt-get (Debian/Ubuntu) or apk (Alpine) base images; this image has neither" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "selfbench: no agent Node runtime for architecture $(uname -m)" >&2; exit 1 ;;
esac
case "$arch-$libc" in
${checksums}
esac
version=${AGENT_NODE_VERSION}
if [ "$libc" = musl ]; then
  name="node-v$version-linux-$arch-musl"
  url="https://unofficial-builds.nodejs.org/download/release/v$version/$name.tar.gz"
else
  name="node-v$version-linux-$arch"
  url="https://nodejs.org/dist/v$version/$name.tar.gz"
fi
work="$(mktemp -d)"
curl -fsSL --retry 3 -o "$work/node.tar.gz" "$url"
echo "$sha  $work/node.tar.gz" | sha256sum -c -
tar -xzf "$work/node.tar.gz" -C "$work"
mkdir -p ${AGENT_RUNTIME_ROOT}
mv "$work/$name" ${AGENT_RUNTIME_ROOT}/node
rm -rf "$work"
${AGENT_RUNTIME_ROOT}/node/bin/node --version
`;
}
