import { patchPaths } from "../../lib/patch-paths.js";
import { shellQuote } from "../../lib/util.js";

export function solutionScript(): string {
  return `#!/bin/bash
set -euo pipefail
git -C /app apply --binary --whitespace=nowarn /solution/gold.patch
`;
}

/** The author's run-tests.sh, run from /app with one argument: which tests to run. */
const RUN_TESTS = "bash /opt/selfbench-runtime/run-tests.sh";

/**
 * Harbor's verifier entry point. It starts the author's services, applies the agent's patch
 * without its changes to any file test.patch touches, applies test.patch over those files' base
 * version, and grades the author's fail-to-pass tests (twice, for determinism) and pass-to-pass
 * tests.
 */
export function testScript(testPatch: string): string {
  const heldOut = patchPaths(testPatch);
  const exclusions = heldOut
    .flatMap((path) => [`--exclude=${shellQuote(path)}`, `--exclude=${shellQuote(`${path}/*`)}`])
    .join(" ");
  const protectedPaths = heldOut.map(shellQuote).join(" ");
  const protectedAbsolute = heldOut.map((path) => shellQuote(`/app/${path}`)).join(" ");
  return `#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier
source /opt/selfbench-runtime/command.sh
# Root steps after our Dockerfile can leave root-owned files in the verifier's caches.
chown -R verifier:verifier /home/verifier 2>/dev/null || true
patch_applied=1
fail_to_pass=0
pass_to_pass=0
deterministic=0
setup_completed=0
fail_to_pass_exit_code=-1
fail_to_pass_repeat_exit_code=-1
pass_to_pass_exit_code=-1
kill_verifier_processes() { pkill -KILL -u "$(id -u verifier)" 2>/dev/null || true; }
protect_held_out_path() {
  local path="$1"
  chown -R root:root -- "$path"
  chmod -R a-w,go+rX -- "$path"
}
# This script runs as root over an /app the verifier user owns; git refuses such a repository
# unless it is marked safe, and every restore below would silently do nothing.
app_git() { git -c safe.directory=/app -C /app "$@"; }

# The agent runs as root beside its baseline, so the baseline must be exactly the post-setup commit
# over this image's HEAD, the snapshot the agent cannot touch.
agent_base_matches() {
  local trees
  trees="$(cat /opt/selfbench/agent-base 2>/dev/null)" || return 1
  [ "$(printf '%s\\n' "$trees" | wc -l)" -eq 2 ] \\
    && [ "$(printf '%s\\n' "$trees" | tail -n 1)" = "$(app_git rev-parse --verify 'HEAD^{tree}')" ]
}
# The task's services start as root from the image as built, before the agent's patch can change
# anything they run. They outlive every test run, which kills only the verifier user's processes.
if (cd /app && bash /opt/selfbench-runtime/services.sh); then
  setup_completed=1
else
  echo "services.sh failed" >&2
fi

if [ ! -f /opt/selfbench/agent.patch ]; then
  patch_applied=0
elif ! agent_base_matches; then
  echo "agent.patch was not diffed against the task's snapshot; refusing to apply it" >&2
  patch_applied=0
elif [ -s /opt/selfbench/agent.patch ]; then
  app_git apply --binary --whitespace=nowarn ${exclusions} /opt/selfbench/agent.patch || patch_applied=0
fi

if [ "$patch_applied" -eq 1 ] && [ "$setup_completed" -eq 1 ]; then
  kill_verifier_processes
  for protected_path in ${protectedPaths}; do
    app_git restore --source=HEAD --staged --worktree -- "$protected_path" 2>/dev/null || true
    app_git clean -fd -- "$protected_path" >/dev/null 2>&1 || true
  done
  app_git apply --binary --whitespace=nowarn /tests/test.patch || patch_applied=0
  if [ "$patch_applied" -eq 1 ]; then
    for protected_path in ${protectedAbsolute}; do protect_held_out_path "$protected_path"; done
  fi
  rm -f /tests/test.patch
fi

if [ "$patch_applied" -eq 1 ] && [ "$setup_completed" -eq 1 ]; then
  cd /app
  if run_verifier_command "${RUN_TESTS} fail-to-pass"; then
    fail_to_pass_exit_code=0
    fail_to_pass=1
    if run_verifier_command "${RUN_TESTS} fail-to-pass"; then
      fail_to_pass_repeat_exit_code=0
      deterministic=1
    else
      fail_to_pass_repeat_exit_code=$?
    fi
  else
    fail_to_pass_exit_code=$?
  fi
  if run_verifier_command "${RUN_TESTS} pass-to-pass"; then
    pass_to_pass_exit_code=0
    pass_to_pass=1
  else
    pass_to_pass_exit_code=$?
  fi
fi

reward=0
if [ "$patch_applied" -eq 1 ] && [ "$fail_to_pass" -eq 1 ] && [ "$pass_to_pass" -eq 1 ] && [ "$deterministic" -eq 1 ]; then reward=1; fi
cat > /logs/verifier/reward.json <<EOF
{"reward": $reward, "patch_applied": $patch_applied, "fail_to_pass": $fail_to_pass, "pass_to_pass": $pass_to_pass, "deterministic": $deterministic, "setup_completed": $setup_completed, "fail_to_pass_exit_code": $fail_to_pass_exit_code, "fail_to_pass_repeat_exit_code": $fail_to_pass_repeat_exit_code, "pass_to_pass_exit_code": $pass_to_pass_exit_code}
EOF
exit 0
`;
}
