export const NOP_REWARD_KEYS = [
  "structured_results",
  "patch_applied",
  "fail_to_pass",
  "pass_to_pass",
  "deterministic",
  "setup_completed",
  "fail_to_pass_exit_code",
  "fail_to_pass_repeat_exit_code",
  "pass_to_pass_exit_code",
] as const;
export const SMOKE_MARKER = "--- selfbench smoke ---";
export const NOP_MARKER = "--- selfbench nop ---";

/** Verifier script for the smoke+nop run; nop rewards are re-emitted under `nop_*` keys. */
export function smokeAndNopScript(): string {
  const fields = NOP_REWARD_KEYS.map(
    (key) => `printf ', "nop_${key}": %s' "$(field ${key} ${key.endsWith("_code") ? "-1" : "0"})"`,
  ).join("\n");
  return `#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier
# Image post-processing after our Dockerfile (Modal runs as root with HOME=/home/verifier) can leave
# root-owned files in the verifier's caches; the runtime user must own its home before it runs.
chown -R verifier:verifier /home/verifier 2>/dev/null || true
echo '${SMOKE_MARKER}'
smoke_status=0
runuser -u verifier --preserve-environment -- env -u XDG_CACHE_HOME HOME=/home/verifier /opt/selfbench-environment/smoke.sh 2>&1 || smoke_status=$?
echo "smoke exit code: $smoke_status"
nop_ran=0
nop_rewards='{}'
if [ "$smoke_status" -eq 0 ]; then
  echo '${NOP_MARKER}'
  nop_ran=1
  /tests/task-test.sh 2>&1 || true
  nop_rewards="$(cat /logs/verifier/reward.json 2>/dev/null || printf '{}')"
fi
field() { printf '%s' "$nop_rewards" | sed -n 's/.*"'"$1"'": *\\(-\\{0,1\\}[0-9]\\{1,\\}\\).*/\\1/p' | head -n 1 | grep . || printf '%s' "$2"; }
{
  printf '{"reward": 0, "smoke_exit_code": %s, "nop_ran": %s' "$smoke_status" "$nop_ran"
${fields}
  printf '}\\n'
} > /logs/verifier/reward.json
exit 0
`;
}
