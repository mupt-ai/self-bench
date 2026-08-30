import type { Candidate, RunRequest } from "../../contracts.js";
import type { DiscoveryShardInput } from "./types.js";

export function discoveryShardPrompt(input: DiscoveryShardInput, provenanceCount: number): string {
  return `Discover and rank SelfBench candidates from this assigned provenance shard. Return at most easy=${input.targetCounts.easy}, medium=${input.targetCounts.medium}, hard=${input.targetCounts.hard}. Before selecting a pull request, query its number against /work/excluded-source-prs.json with jq; do not print or read the full exclusion list into context. The submit_discovery tool also removes any already-considered pull requests as a final safeguard.

Assign each candidate exactly one difficulty using the separable implementation core, excluding tests, generated code, formatting churn, and unrelated cleanup:
- easy: at least 20 changed implementation lines across at least 1 implementation file, with at least 1 viable fail-to-pass test;
- medium: at least 50 changed implementation lines across at least 2 implementation files, with at least 1 fail-to-pass and 1 pass-to-pass test;
- hard: at least 100 changed implementation lines across at least 3 implementation files, with at least 1 fail-to-pass and 2 pass-to-pass tests.
Choose the highest tier whose thresholds the candidate honestly meets. Every tier also requires focused public behavior, separable held-out tests, deterministic setup, and an authentic pre-implementation request. Prefer stable public APIs, commands, persistence boundaries, or extension seams.

Every candidate must be a pull request from SOURCE_REPO_URL. Repository names or pull requests mentioned inside provenance messages are context only; never follow them into another repository. sourceUrl must be the canonical GitHub pull-request URL for SOURCE_REPO_URL and sourcePr must match its number.

The sanitized corpus at /work/provenance.jsonl contains ${provenanceCount} human requests. Local Pi, Claude Code, and Codex requests are preferred when they clearly correspond to the same change. A local record with sourcePr and sourceUrl has an explicit user-supplied association and may be used only for that PR. Records with sourceType github-pull-request contain the non-bot PR author's exact title and optional body and are valid fallback provenance; they too may be used only for their own sourcePr and sourceUrl. Select provenance only by an exact sourceType, sessionId, and messageIndex present in the corpus. Never invent or reconstruct request text from implementation or tests. Inspect merged PR metadata and diffs with gh and git. Resolve the exact base and completed 40-character commits. Do not modify the repository.

Return fewer candidates when the shard does not contain enough valid requests; an empty candidate list is valid. Call submit_discovery exactly once. Do not return prose after the tool call.`;
}
export function authoringPrompt(run: RunRequest, candidate: Candidate): string {
  const tierRequirements = {
    easy: "at least 20 changed implementation lines across at least 1 implementation file, at least 1 fail-to-pass test, and no pass-to-pass minimum",
    medium:
      "at least 50 changed implementation lines across at least 2 implementation files, at least 1 fail-to-pass test, and at least 1 pass-to-pass test",
    hard: "at least 100 changed implementation lines across at least 3 implementation files, at least 1 fail-to-pass test, and at least 2 pass-to-pass tests",
  } as const;
  return `Author exactly one ${candidate.difficulty} SelfBench task for this assigned candidate:

${JSON.stringify(
  {
    sourcePr: candidate.sourcePr,
    sourceUrl: candidate.sourceUrl,
    baseCommit: candidate.baseCommit,
    completedCommit: candidate.completedCommit,
    request: candidate.request,
  },
  null,
  2,
)}

Use only this candidate. Do not discover alternatives and do not run Harbor. Read /work/provenance.json only to verify the supplied authentic request. Inspect the base and completed commits. Split the completed change into a non-test gold patch and a held-out test patch. The task must meet ${candidate.difficulty} mode: ${tierRequirements[candidate.difficulty]}.

Held-out tests must verify public behavior through an existing API, command, persistence boundary, or extension seam. When the request is about an endpoint/provider contract, exercise that boundary instead of manually composing internal translators, context/option builders, or model factories. Do not import gold-specific private helpers/modules or assert exact internal SQL, query counts, schema/index names, object identity, telemetry layout, error wording, endpoint/response shapes, or UI copy/order unless the authentic request explicitly makes that artifact public. Assert requested semantic values rather than larger retained/raw payloads that happen to contain them, and preserve valid adjacent input content unless the request says to discard it. Cover every material behavior in the prompt, including central authorization, error, and UI states. A different correct implementation with different helpers, file boundaries, API presentation, and UI composition must be able to pass; reject the candidate when no stable public seam exists.

Call submit_task exactly once. Its definition must use schemaVersion 2 and difficulty "${candidate.difficulty}". testCommand must contain the literal {tests} exactly once as an unquoted shell argument list, and every selected test path must be supplied only through that placeholder—never quote the whole placeholder, assign it to one scalar, or hard-code a fail-to-pass or pass-to-pass path elsewhere in the command. Use one repository-native test mode and bundler per command rather than chaining equivalent suites or bypassing repository wrappers with a generic runner. The prompt must not mention the PR, commits, patches, test names, or implementation. Inspect repository test scripts and CI only to select the correct test command. Do not submit runtimes, setup commands, system dependencies, services, or any other environment configuration; a separate environment agent owns that contract.

Before submission, verify from repository scripts and the pinned diff that the selected test identifiers belong to one repository-native test command and form the required nop/oracle split. Do not invent a test command when no stable test seam exists. A separate environment agent and backend preflight own dependency setup and executable proof. Default resources are 4 CPU, 8192 MB memory, 20480 MB storage; default timeouts are 900 setup, 2400 agent, 900 tests. Do not return prose after the tool call.

Pinned SelfBench version: ${run.version.selfbenchCommit}.`;
}
export function modalAgentScript(extension: string, tool: string): string {
  return `${sandboxBootstrap()}
clone_source
cd /work/repo
run_with_heartbeat pi --print --mode json --no-session --no-approve --no-skills --no-prompt-templates --no-context-files --no-extensions \\
  --extension /work/${extension} --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,grep,find,ls,${tool} "$(cat /work/prompt.txt)"`;
}
export function authoringScript(): string {
  return `${sandboxBootstrap()}
clone_source
mkdir -p /work/tasks
cd /work/repo
run_with_heartbeat pi --print --mode json --no-session --no-approve --no-prompt-templates --no-context-files --no-extensions \\
  --skill /work/selfbench-skill --extension /work/authoring.ts \\
  --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,grep,find,ls,submit_task "$(cat /work/prompt.txt)"
node /work/sandbox-author.js /work/tasks /work/source-task.tar.gz /work/definition.json`;
}
export function environmentScript(): string {
  return `${sandboxBootstrap()}
clone_source
mkdir -p /work/environment-output
cd /work/repo
run_with_heartbeat pi --print --mode json --no-session --no-approve --no-skills --no-prompt-templates --no-context-files --no-extensions \\
  --extension /work/environment.ts --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,grep,find,ls,submit_environment "$(cat /work/prompt.txt)"
node /work/sandbox-environment.js /work/draft-definition.json \\
  /work/environment-output/environment.json /work/definition.json`;
}
export function environmentPreflightScript(): string {
  return `#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier
smoke_status=0
nop_status=1
output="$(mktemp /tmp/selfbench-environment-smoke-XXXXXX.log)"
runuser -u verifier --preserve-environment -- /opt/selfbench-environment/smoke.sh >"$output" 2>&1 || smoke_status=$?
cat "$output"
rm -f "$output"
if [ "$smoke_status" -eq 0 ]; then
  /tests/task-test.sh
  if grep -q '"patch_applied": 1' /logs/verifier/reward.json \\
    && grep -q '"fail_to_pass": 0' /logs/verifier/reward.json \\
    && grep -q '"pass_to_pass": 1' /logs/verifier/reward.json \\
    && grep -q '"setup_completed": 1' /logs/verifier/reward.json; then
    nop_status=0
  fi
fi
reward=0
if [ "$smoke_status" -eq 0 ] && [ "$nop_status" -eq 0 ]; then reward=1; fi
printf '{"reward": %s, "smoke_exit_code": %s, "nop_exit_code": %s}\n' "$reward" "$smoke_status" "$nop_status" > /logs/verifier/reward.json
exit 0
`;
}
function sandboxBootstrap(): string {
  return `set -euo pipefail
mkdir -p "$HOME/.pi/agent"
if [ -n "\${SELFBENCH_PI_AUTH_JSON:-}" ]; then
  printf '%s' "$SELFBENCH_PI_AUTH_JSON" > "$HOME/.pi/agent/auth.json"
  chmod 600 "$HOME/.pi/agent/auth.json"
fi
printf '%s\n' '{"transport":"auto"}' > "$HOME/.pi/agent/settings.json"
chmod 600 "$HOME/.pi/agent/settings.json"
model_provider() { [ -n "\${OPENAI_API_KEY:-}" ] && printf openai || printf openai-codex; }
run_with_heartbeat() {
  "$@" 2>&1 &
  local command_pid=$!
  (
    while sleep 60; do
      printf '[selfbench] agent process %s still running at %s\n' "$command_pid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
    done
  ) &
  local heartbeat_pid=$!
  trap 'kill "$command_pid" "$heartbeat_pid" 2>/dev/null || true' TERM INT
  set +e
  wait "$command_pid"
  local command_status=$?
  set -e
  kill "$heartbeat_pid" 2>/dev/null || true
  wait "$heartbeat_pid" 2>/dev/null || true
  trap - TERM INT
  return "$command_status"
}
cleanup() { rm -f "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/settings.json" "$HOME/.git-credentials"; }
trap cleanup EXIT
clone_source() {
  if [ -n "\${GH_TOKEN:-}" ]; then
    git config --global credential.helper store
    printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > "$HOME/.git-credentials"
    chmod 600 "$HOME/.git-credentials"
  fi
  git clone --no-checkout --filter=blob:none "$SOURCE_REPO_URL" /work/repo
  git -C /work/repo fetch origin "$SOURCE_COMMIT"
  git -C /work/repo checkout --detach "$SOURCE_COMMIT"
}`;
}
