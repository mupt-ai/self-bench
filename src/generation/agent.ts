import type { ArtifactStore } from "../artifacts/index.js";
import type { ArtifactRef, RunRequest } from "../contracts/index.js";
import { PiEventFeed } from "../harnesses/pi/event-feed.js";
import { loadPiModelAuth, piModelAuthSecrets } from "../harnesses/pi/model-auth.js";
import { finalAssistantMessage, sessionProviderError } from "../harnesses/pi/session.js";
import {
  type LiveSandbox,
  SandboxExecutionError,
  type SandboxExecutor,
  type SandboxFile,
  type SandboxResult,
} from "../sandbox/index.js";
import { githubToken } from "../third_party/github/token.js";
import { withHeartbeats } from "./helpers.js";

const SESSION_DIRECTORY = "/work/session";
const SESSION_OUTPUT = "/work/session.jsonl";
const RESUMED_SESSION = `${SESSION_DIRECTORY}/resume.jsonl`;
/** An agent printing nothing for this long is treated as hung. */
const INACTIVITY_TIMEOUT_MS = 8 * 60 * 1000;

export interface AgentRequest {
  readonly store: ArtifactStore;
  readonly sandbox: SandboxExecutor;
  readonly run: RunRequest;
  /** Sandbox label, e.g. `author-<candidate>-r2`. */
  readonly label: string;
  /** Where this attempt's prompt, log, and live feed are written. */
  readonly prefix: string;
  readonly logName?: string;
  /** Where the pi session is stored; omit when the session is not kept. */
  readonly sessionKey?: string;
  /** A previous session to continue. */
  readonly resume?: Uint8Array;
  /** `clone`: /work/repo at `commit`. `task`: unpack /work/task.tar.gz with the verifier program. */
  readonly workspace:
    | { readonly kind: "clone"; readonly commit: string }
    | { readonly kind: "task" };
  readonly extension: string;
  readonly tools: string;
  readonly prompt: string;
  readonly files: readonly SandboxFile[];
  readonly outputs: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Runs alongside the agent (the in-session verify mailbox). */
  readonly whileRunning?: (sandbox: LiveSandbox, exited: AbortSignal) => Promise<void>;
}

export interface AgentResult {
  readonly exitCode: number;
  readonly outputs: SandboxResult["outputs"];
  readonly log: ArtifactRef;
  readonly session?: ArtifactRef;
  /** The agent's last message, for explaining a round that delivered nothing. */
  readonly finalMessage?: string;
  /** Set when the model provider ended the session with an error. */
  readonly providerError?: string;
}

/** Runs pi once in a fresh sandbox and stores its prompt, log, live feed, and session. */
export async function runAgent(request: AgentRequest): Promise<AgentResult> {
  const { store, run, prefix } = request;
  const [auth, token] = await Promise.all([loadPiModelAuth(), githubToken()]);
  await store.put(`${prefix}/prompt.md`, Buffer.from(request.prompt), "text/markdown");
  const logKey = `${prefix}/${request.logName ?? "sandbox.log"}`;
  const feed = liveFeed(store, prefix, [auth.apiKey ?? "", auth.authJson ?? "", token ?? ""]);
  let result: SandboxResult;
  try {
    result = await withHeartbeats(`running ${request.label}`, (options) =>
      request.sandbox.run(
        {
          runId: run.runId,
          stage: request.label,
          timeoutMs: request.timeoutMs,
          inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
          command: ["bash", "-lc", agentScript(request)],
          files: [
            ...request.files,
            { path: "/work/prompt.txt", contents: request.prompt },
            ...(request.resume ? [{ path: RESUMED_SESSION, contents: request.resume }] : []),
          ],
          outputPaths: [...request.outputs, SESSION_OUTPUT],
          secrets: { ...piModelAuthSecrets(auth), ...(token ? { GH_TOKEN: token } : {}) },
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
        {
          ...options,
          onOutput: feed.push,
          ...(request.whileRunning ? { onLive: request.whileRunning } : {}),
        },
      ),
    );
  } catch (error) {
    if (error instanceof SandboxExecutionError) {
      const log = await store.put(logKey, logBytes(error.result), "text/plain");
      throw new Error(`${error.message}; partial log: ${log.uri}`, { cause: error });
    }
    throw error;
  } finally {
    await feed.close();
  }
  const log = await store.put(logKey, logBytes(result), "text/plain");
  const outputs = Object.fromEntries(
    Object.entries(result.outputs).filter(([, bytes]) => bytes.length > 0),
  );
  const sessionBytes = outputs[SESSION_OUTPUT];
  const session =
    request.sessionKey && sessionBytes
      ? await store.put(request.sessionKey, sessionBytes, "application/x-ndjson")
      : undefined;
  const finalMessage = sessionBytes ? finalAssistantMessage(sessionBytes) : undefined;
  const providerError = sessionBytes ? sessionProviderError(sessionBytes) : undefined;
  return {
    exitCode: result.exitCode,
    outputs,
    log,
    ...(session ? { session } : {}),
    ...(finalMessage ? { finalMessage } : {}),
    ...(providerError ? { providerError } : {}),
  };
}

function logBytes(result: Pick<SandboxResult, "stdout" | "stderr">): Buffer {
  return Buffer.from(`${result.stdout}\n${result.stderr}`);
}

export function agentScript(request: AgentRequest): string {
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
# Keep output flowing while a tool call (verify) blocks, so the inactivity timeout never fires.
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
# Providers require every declared output after exit 0; an empty file means "not produced".
for path in ${[...request.outputs, SESSION_OUTPUT].join(" ")}; do
  [ -f "$path" ] || { mkdir -p "$(dirname "$path")"; : > "$path"; }
done
echo "[selfbench] pi exited with $status"
exit "$status"`;
}

/** Publishes the agent's public events as immutable snapshots every two seconds for the UI. */
export function liveFeed(store: ArtifactStore, prefix: string, secrets: readonly string[]) {
  const feed = new PiEventFeed(secrets);
  let sequence = 0;
  let previous = "";
  let pending: Promise<void> = Promise.resolve();
  const flush = () => {
    pending = pending.then(async () => {
      const events = feed.events();
      const snapshot = JSON.stringify(events);
      if (snapshot === previous || events.length === 0) return;
      const key = `${prefix}/live/${String(sequence).padStart(8, "0")}.json`;
      const body = JSON.stringify({ events, capturedAt: new Date().toISOString() });
      // The feed is observational; a failed snapshot is retried on the next tick.
      await store.put(key, Buffer.from(body), "application/json").then(
        () => {
          previous = snapshot;
          sequence += 1;
        },
        () => undefined,
      );
    });
    return pending;
  };
  const timer = setInterval(flush, 2000);
  timer.unref();
  return {
    push: (stream: "stdout" | "stderr", chunk: Uint8Array) => {
      if (stream === "stdout") feed.push(chunk);
    },
    close: async () => {
      clearInterval(timer);
      await flush();
    },
  };
}
