import type { TaskDefinition } from "../contracts.js";
import { patchPaths } from "../repair.js";
import { repositoryRelativePath, shellQuote } from "./paths.js";

export function solutionScript(): string {
  return `#!/bin/bash
set -euo pipefail
git -C /app apply --binary --whitespace=nowarn /solution/gold.patch
`;
}

export function testScript(task: TaskDefinition, testPatch: string): string {
  const repositoryTestPaths = [
    ...new Set([
      ...task.testPaths.map((path) => repositoryRelativePath(task, path)),
      ...patchPaths(testPatch),
    ]),
  ].sort();
  const exclusions = repositoryTestPaths
    .flatMap((path) => [
      `--exclude=${shellQuote(path.replace(/\/$/, ""))}`,
      `--exclude=${shellQuote(`${path.replace(/\/$/, "")}/*`)}`,
    ])
    .join(" ");
  const protectedPaths = repositoryTestPaths.map(shellQuote).join(" ");
  const protectedAbsolute = repositoryTestPaths.map((path) => shellQuote(`/app/${path}`)).join(" ");
  const structured = task.testResults;
  const f2p = taskCommand(task, task.failToPass);
  const p2p = task.passToPass.length > 0 ? taskCommand(task, task.passToPass) : "true";
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

if [ ! -f /opt/selfbench/agent.patch ]; then
  patch_applied=0
elif [ -s /opt/selfbench/agent.patch ]; then
  git -C /app apply --binary --whitespace=nowarn ${exclusions} /opt/selfbench/agent.patch || patch_applied=0
fi

if [ "$patch_applied" -eq 1 ]; then setup_completed=1; fi

if [ "$patch_applied" -eq 1 ] && [ "$setup_completed" -eq 1 ]; then
  kill_verifier_processes
  for protected_path in ${protectedPaths}; do
    git -C /app restore --source=HEAD --staged --worktree -- "$protected_path" 2>/dev/null || true
    git -C /app clean -fd -- "$protected_path" >/dev/null 2>&1 || true
  done
  git -C /app apply --allow-empty --binary --whitespace=nowarn /tests/test.patch || patch_applied=0
  if [ "$patch_applied" -eq 1 ]; then
    for protected_path in ${protectedAbsolute}; do protect_held_out_path "$protected_path"; done
  fi
  rm -f /tests/test.patch
fi

if [ "$patch_applied" -eq 1 ] && [ "$setup_completed" -eq 1 ]; then
  cd ${shellQuote(`/app/${task.workdir}`)}
  if run_verifier_command ${shellQuote(f2p)} ${structured ? "junit" : "command"} ${shellQuote(JSON.stringify(structured?.failToPass ?? []))}; then
    fail_to_pass_exit_code=0
    fail_to_pass=1
    if run_verifier_command ${shellQuote(f2p)} ${structured ? "junit" : "command"} ${shellQuote(JSON.stringify(structured?.failToPass ?? []))}; then
      fail_to_pass_repeat_exit_code=0
      deterministic=1
    else
      fail_to_pass_repeat_exit_code=$?
    fi
  else
    fail_to_pass_exit_code=$?
  fi
  if [ "${task.passToPass.length}" -eq 0 ]; then
    pass_to_pass_exit_code=0
    pass_to_pass=1
  elif run_verifier_command ${shellQuote(p2p)} ${structured ? "junit" : "command"} ${shellQuote(JSON.stringify(structured?.passToPass ?? []))}; then
    pass_to_pass_exit_code=0
    pass_to_pass=1
  else
    pass_to_pass_exit_code=$?
  fi
fi

reward=0
if [ "$patch_applied" -eq 1 ] && [ "$fail_to_pass" -eq 1 ] && [ "$pass_to_pass" -eq 1 ] && [ "$deterministic" -eq 1 ]; then reward=1; fi
cat > /logs/verifier/reward.json <<EOF
{"structured_results": ${structured ? 1 : 0}, "reward": $reward, "patch_applied": $patch_applied, "fail_to_pass": $fail_to_pass, "pass_to_pass": $pass_to_pass, "deterministic": $deterministic, "setup_completed": $setup_completed, "fail_to_pass_exit_code": $fail_to_pass_exit_code, "fail_to_pass_repeat_exit_code": $fail_to_pass_repeat_exit_code, "pass_to_pass_exit_code": $pass_to_pass_exit_code}
EOF
exit 0
`;
}

function taskCommand(task: TaskDefinition, tests: readonly string[]): string {
  return task.testCommand.replaceAll("{tests}", tests.map(shellQuote).join(" "));
}
