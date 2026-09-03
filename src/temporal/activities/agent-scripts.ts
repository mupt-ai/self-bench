import {
  collectPiSessionScript,
  PI_SESSION_DIRECTORY,
  PI_SESSION_OUTPUT_PATH,
  piSessionArguments,
} from "../../pi-session.js";
import { MAILBOX_DIRECTORY, MAILBOX_DONE } from "../../sandbox/supervisor.js";
import { WRAPPER_STATUS_PATH } from "./round-outcome.js";
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
export function modalAgentScript(extension: string, tool: string): string {
  return `${sandboxBootstrap()}
clone_source
cd /work/repo
run_with_heartbeat pi --print --mode json --no-session --no-approve --no-skills --no-prompt-templates --no-context-files --no-extensions \\
  --extension /work/${extension} --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,grep,find,ls,${tool} "$(cat /work/prompt.txt)"`;
}
/**
 * One authoring round. Round 1 starts a new pi session; later rounds resume the restored session
 * with the verification report as the next user message. The session file is always collected,
 * even when the agent submits nothing, so the conversation survives a rejected round's diagnosis.
 */
export function authoringRoundScript(resume: boolean): string {
  return `${sandboxBootstrap()}
${collectPiSessionScript()}
${mailboxSetup()}
clone_source
mkdir -p /work/tasks /work/task ${PI_SESSION_DIRECTORY}
cd /work/repo
agent_status=0
run_with_heartbeat pi --print --mode json ${piSessionArguments(resume).join(" ")} --no-approve --no-prompt-templates --no-context-files --no-extensions \\
  --skill /work/selfbench-skill --extension /work/authoring.js \\
  --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,grep,find,ls,verify,submit_task "$(cat /work/prompt.txt)" || agent_status=$?
collect_session
echo "[selfbench] pi exited with $agent_status"
[ "$agent_status" -eq 0 ] || { wrapper_status=$agent_status; exit "$agent_status"; }
node /work/sandbox-author.js /work/tasks /work/source-task.tar.gz /work/definition.json
${reportOutputs(["/work/source-task.tar.gz", "/work/definition.json", PI_SESSION_OUTPUT_PATH])}
wrapper_status=0`;
}
/**
 * One verification round. The sandbox program unpacks the compiled task and materializes the
 * base snapshot with the held-out patch applied; pi then accepts or fixes. Outputs are always
 * written so providers that require every declared output on success stay satisfied.
 */
export function verifierRoundScript(resume: boolean): string {
  return `${sandboxBootstrap()}
${collectPiSessionScript()}
${mailboxSetup()}
mkdir -p /work/verdict /work/fix ${PI_SESSION_DIRECTORY}
node /work/sandbox-verifier.js /work/task.tar.gz
cd /work/repo
agent_status=0
run_with_heartbeat pi --print --mode json ${piSessionArguments(resume).join(" ")} --no-approve --no-skills --no-prompt-templates --no-context-files --no-extensions \\
  --extension /work/verifier.js --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,edit,write,grep,find,ls,verify,accept_task,submit_fix "$(cat /work/prompt.txt)" || agent_status=$?
collect_session
echo "[selfbench] pi exited with $agent_status"
[ -f /work/verdict/verdict.json ] || printf '{"kind": "none"}\\n' > /work/verdict/verdict.json
[ -f /work/fix/fixed-definition.json ] || printf '{}\\n' > /work/fix/fixed-definition.json
[ -f /work/fix/fixed-test.patch ] || : > /work/fix/fixed-test.patch
[ -f ${PI_SESSION_OUTPUT_PATH} ] || : > ${PI_SESSION_OUTPUT_PATH}
${reportOutputs(["/work/verdict/verdict.json", "/work/fix/fixed-definition.json", "/work/fix/fixed-test.patch", PI_SESSION_OUTPUT_PATH])}
wrapper_status=$agent_status
exit "$agent_status"`;
}
/** Prints which declared outputs exist so the archived sandbox result explains a missing read. */
function reportOutputs(paths: readonly string[]): string {
  return `outputs_report=""
for output_path in ${paths.join(" ")}; do
  if [ -f "$output_path" ]; then outputs_report="$outputs_report $output_path:present($(wc -c < "$output_path" | tr -d ' ')B)"; else outputs_report="$outputs_report $output_path:missing"; fi
done
echo "[selfbench] outputs:$outputs_report"`;
}
/**
 * Mailbox directories for the in-session verify tool; the done marker tells the worker's
 * supervisor that the agent command is over even if the provider exit signal lags.
 */
/**
 * The EXIT trap records the wrapper's status for the worker. The script sets `wrapper_status`
 * to the status it intends right before it ends, because with a real pi session `$?` at trap
 * entry has been observed as 1 after `exit 0`; the trap also logs the command it fired on.
 */
function mailboxSetup(): string {
  return `mkdir -p ${MAILBOX_DIRECTORY}/requests ${MAILBOX_DIRECTORY}/responses
finish_round() {
  local status=$?
  printf '[selfbench] exit trap: status=%s command=[%s] line=%s\\n' "$status" "$BASH_COMMAND" "$LINENO" >&2
  if [ -n "\${wrapper_status:-}" ]; then status=$wrapper_status; fi
  cleanup
  printf '%s\\n' "$status" > ${WRAPPER_STATUS_PATH}
  : > ${MAILBOX_DONE}
}
trap finish_round EXIT`;
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
