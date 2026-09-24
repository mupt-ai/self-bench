import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef, RunRequest } from "../../contracts/index.js";
import { loadPiModelAuth, piModelAuthSecrets } from "../../harnesses/pi/model-auth.js";
import type { SandboxExecutor, SandboxFile } from "../../sandbox/index.js";
import type { SandboxJobOutcome } from "../../sandbox/jobs.js";
import { githubToken } from "../../third_party/github/token.js";
import {
  AGENT_RECORD_NAME,
  AGENT_RESULT_NAME,
  type AgentRunRecord,
  type AgentRunResult,
} from "../runs/types.js";
import { artifactFile } from "./helpers.js";
import { runSandboxJob, type SandboxCallback } from "./sandbox-job.js";

const SESSION_DIRECTORY = "/work/session";
const SESSION_OUTPUT = "/work/session.jsonl";
const RESUMED_SESSION = `${SESSION_DIRECTORY}/resume.jsonl`;
/** An agent printing nothing for this long is treated as hung. */
const INACTIVITY_TIMEOUT_MS = 8 * 60 * 1000;

export interface AgentRequest {
  readonly store: ArtifactStore;
  readonly sandbox: SandboxExecutor;
  readonly callback: SandboxCallback;
  readonly run: RunRequest;
  /** Sandbox label, e.g. `author-<candidate>-r2`. */
  readonly label: string;
  /** Where this attempt's prompt, log, live feed, session, and outputs are written. */
  readonly prefix: string;
  readonly logName?: string;
  /** Recorded as `<prefix>/agent.json` so the agent work sheet can list this run. */
  readonly record?: Pick<AgentRunRecord, "stage" | "round" | "turn" | "attempt">;
  /** A previous session to continue. */
  readonly resume?: ArtifactRef;
  /** `clone`: /work/repo at `commit`. `task`: unpack /work/task.tar.gz with the verifier program. */
  readonly workspace:
    | { readonly kind: "clone"; readonly commit: string }
    | { readonly kind: "task" };
  /** Shell run in the workspace after it is prepared, before pi starts. */
  readonly setup?: string;
  readonly extension: string;
  readonly tools: string;
  readonly prompt: string;
  readonly files: readonly SandboxFile[];
  /** Files under /work the agent may produce, uploaded when it ends. */
  readonly outputs: readonly string[];
  /** Outputs that are small JSON documents, also returned inline. */
  readonly inline?: readonly string[];
  /** Sets of outputs that each count as a delivered result (see `JobSpec.delivers`). */
  readonly delivers?: readonly (readonly string[])[];
  readonly requireDelivery?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface AgentResult {
  readonly exitCode: number;
  /** Uploaded outputs by their sandbox path. */
  readonly outputs: Readonly<Record<string, ArtifactRef>>;
  /** Inline outputs by their sandbox path. */
  readonly inline: Readonly<Record<string, unknown>>;
  readonly log?: ArtifactRef;
  readonly session?: ArtifactRef;
  /** The agent's last message, for explaining a round that delivered nothing. */
  readonly finalMessage?: string;
  /** Set when the model provider ended the session with an error. */
  readonly providerError?: string;
}

/** An output's upload name: its path under /work. */
const outputName = (path: string) => path.replace(/^\/work\//, "");

/**
 * Starts pi in a detached sandbox that reports through the callback API; the activity completes
 * when the sandbox reports back, and `finishAgent` then reads the result.
 */
export async function startAgent(request: AgentRequest): Promise<SandboxJobOutcome> {
  const { store, run, prefix } = request;
  const [auth, token] = await Promise.all([loadPiModelAuth(), githubToken()]);
  const secrets = { ...piModelAuthSecrets(auth), ...(token ? { GH_TOKEN: token } : {}) };
  await store.put(`${prefix}/prompt.md`, Buffer.from(request.prompt), "text/markdown");
  if (request.record) {
    await writeRecord(store, {
      ...request.record,
      prefix,
      session: `${prefix}/${outputName(SESSION_OUTPUT)}`,
      startedAt: new Date().toISOString(),
    });
  }
  return await runSandboxJob(
    request.sandbox,
    {
      prefix,
      request: {
        runId: run.runId,
        stage: request.label,
        timeoutMs: request.timeoutMs,
        // Not a login shell: started straight from the job runner, bash would be at SHLVL 1 and
        // the image's ~/.bash_logout (clear_console, which fails without a console) would turn
        // pi's exit code into 1.
        command: ["bash", "-c", agentScript(request)],
        files: [
          ...request.files,
          { path: "/work/prompt.txt", contents: request.prompt },
          ...(request.resume ? [await artifactFile(store, request.resume, RESUMED_SESSION)] : []),
        ],
        secrets,
        environment: {
          ...request.environment,
          SOURCE_REPO_URL: run.repository.url,
          ...(request.workspace.kind === "clone"
            ? { SOURCE_COMMIT: request.workspace.commit }
            : {}),
          AUTHOR_MODEL: run.authoring.model,
          AUTHOR_PROVIDER: auth.provider,
          AUTHOR_THINKING: run.authoring.reasoningEffort,
        },
      },
      outputs: [...request.outputs, SESSION_OUTPUT].map((path) => ({
        name: outputName(path),
        path,
        contentType: contentType(path),
      })),
      inline: (request.inline ?? []).map((path) => ({ name: outputName(path), path })),
      // A result counts as delivered only with the session that produced it.
      ...(request.delivers
        ? { delivers: request.delivers.map((paths) => [...paths, SESSION_OUTPUT]) }
        : {}),
      ...(request.requireDelivery ? { requireDelivery: true } : {}),
      log: request.logName ?? "sandbox.log",
      inactivityMs: INACTIVITY_TIMEOUT_MS,
      agent: { live: "live", redact: Object.keys(secrets), session: SESSION_OUTPUT },
    },
    request.callback,
  );
}

/** Stops the agent's sandbox, bills it, and returns what the agent left behind. */
export async function finishAgent(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  outcome: SandboxJobOutcome,
  logName = "sandbox.log",
): Promise<AgentResult> {
  await sandbox.stop(outcome.sandbox, outcome.usage).catch(() => undefined);
  const byPath = <T>(entries: Readonly<Record<string, T>>) =>
    Object.fromEntries(Object.entries(entries).map(([name, value]) => [`/work/${name}`, value]));
  // Artifacts are write-once: the end goes to result.json beside the start in agent.json, and a
  // retried finish keeps the result the first one wrote.
  const [recorded, finished] = await Promise.all(
    [AGENT_RECORD_NAME, AGENT_RESULT_NAME].map((name) => store.stat(`${outcome.prefix}/${name}`)),
  );
  if (recorded && !finished) {
    const result: AgentRunResult = {
      finishedAt: new Date().toISOString(),
      exitCode: outcome.exitCode,
      ...(outcome.providerError ? { error: outcome.providerError.slice(0, 500) } : {}),
    };
    await store.put(
      `${outcome.prefix}/${AGENT_RESULT_NAME}`,
      Buffer.from(JSON.stringify(result)),
      "application/json",
    );
  }
  const log = outcome.files[logName];
  const session = outcome.files[outputName(SESSION_OUTPUT)];
  return {
    exitCode: outcome.exitCode,
    outputs: byPath(outcome.files),
    inline: byPath(outcome.inline),
    ...(log ? { log } : {}),
    ...(session ? { session } : {}),
    ...(outcome.finalMessage ? { finalMessage: outcome.finalMessage } : {}),
    ...(outcome.providerError ? { providerError: outcome.providerError } : {}),
  };
}

function writeRecord(store: ArtifactStore, record: AgentRunRecord) {
  return store.put(
    `${record.prefix}/${AGENT_RECORD_NAME}`,
    Buffer.from(JSON.stringify(record)),
    "application/json",
  );
}

function contentType(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".jsonl")) return "application/x-ndjson";
  if (path.endsWith(".tar.gz")) return "application/gzip";
  return "application/octet-stream";
}

export function agentScript(
  request: Pick<AgentRequest, "workspace" | "resume" | "setup" | "extension" | "tools">,
): string {
  const workspace =
    request.workspace.kind === "clone"
      ? `if [ -n "\${GH_TOKEN:-}" ]; then
  git config --global credential.helper store
  printf 'https://x-access-token:%s@github.com\\n' "$GH_TOKEN" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
fi
git clone --no-checkout --filter=blob:none "$SOURCE_REPO_URL" /work/repo
git -C /work/repo fetch origin "$SOURCE_COMMIT"
git -C /work/repo checkout --detach "$SOURCE_COMMIT"`
      : "node /work/sandbox-verifier.js /work/task.tar.gz";
  const resume = request.resume ? ` --session ${RESUMED_SESSION}` : "";
  return `set -euo pipefail
mkdir -p "$HOME/.pi/agent" ${SESSION_DIRECTORY}
cleanup() { rm -f "$HOME/.pi/agent/auth.json" "$HOME/.git-credentials"; }
trap cleanup EXIT
if [ -n "\${SELFBENCH_PI_AUTH_JSON:-}" ]; then
  printf '%s' "$SELFBENCH_PI_AUTH_JSON" > "$HOME/.pi/agent/auth.json"
  chmod 600 "$HOME/.pi/agent/auth.json"
fi
printf '%s\\n' '{"transport":"auto"}' > "$HOME/.pi/agent/settings.json"
provider="\${AUTHOR_PROVIDER:-}"
[ -n "$provider" ] || { [ -n "\${OPENAI_API_KEY:-}" ] && provider=openai || provider=openai-codex; }
${workspace}
cd /work/repo
${request.setup ?? ""}
# Keep output flowing while a long tool call runs, so the inactivity timeout never fires.
(while sleep 60; do echo "[selfbench] agent still running" >&2; done) &
heartbeat=$!
status=0
pi --print --mode json --session-dir ${SESSION_DIRECTORY}${resume} --no-approve --no-skills \\
  --no-prompt-templates --no-context-files --no-extensions --extension ${request.extension} \\
  --provider "$provider" --model "$AUTHOR_MODEL" --thinking "\${AUTHOR_THINKING:-high}" \\
  --tools ${request.tools} "$(cat /work/prompt.txt)" 2>&1 || status=$?
kill "$heartbeat" 2>/dev/null || true
session="${RESUMED_SESSION}"
[ -f "$session" ] || session="$(ls -1 ${SESSION_DIRECTORY}/*.jsonl 2>/dev/null | head -n 1 || true)"
if [ -n "$session" ]; then cp "$session" ${SESSION_OUTPUT}; fi
echo "[selfbench] pi exited with $status"
exit "$status"`;
}
