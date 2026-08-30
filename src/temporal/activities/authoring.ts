import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import {
  type Candidate,
  type RunRequest,
  type TaskAuthorOutcome,
  taskDraftDefinitionSchema,
} from "../../contracts.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { githubToken, loadPiModelAuth } from "../../subscription-auth.js";
import { authoringPrompt, authoringScript } from "./agent-scripts.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, AUTHORING_TIMEOUT_MS } from "./constants.js";
import { readAsset, runSandboxWithFailureLog, withActivityHeartbeats } from "./runtime.js";
import type { AuthorCandidateInput } from "./types.js";

export async function authorCandidate(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: AuthorCandidateInput,
): Promise<TaskAuthorOutcome> {
  const { run, candidate } = input;
  Context.current().heartbeat(`authoring ${candidate.candidateId}`);
  const checkpointPrefix = `runs/${run.runId}/authoring/${candidate.candidateId}`;
  const [definitionCheckpoint, sourceCheckpoint] = await Promise.all([
    store.getByKey(`${checkpointPrefix}/definition.json`),
    store.getByKey(`${checkpointPrefix}/source-task.tar.gz`),
  ]);
  if (definitionCheckpoint || sourceCheckpoint) {
    if (!definitionCheckpoint || !sourceCheckpoint) {
      throw new Error(`incomplete authoring checkpoint for ${candidate.candidateId}`);
    }
    return await materializeAuthoredTaskDraft(
      store,
      run,
      candidate,
      definitionCheckpoint,
      sourceCheckpoint,
    );
  }
  const [provenance, extension, skill, compiler, piAuth, ghToken] = await Promise.all([
    store.get(candidate.provenance),
    readAsset("src/extensions/authoring.ts"),
    readAsset("src/skills/selfbench/SKILL.md"),
    readAsset("dist/sandbox-author.bundle.js"),
    loadPiModelAuth(),
    githubToken(),
  ]);
  const prompt = authoringPrompt(run, candidate);
  const attemptLogKey = `runs/${run.runId}/authoring/${candidate.candidateId}/attempt-${Context.current().info.attempt}/modal.log`;
  const result = await runSandboxWithFailureLog(store, attemptLogKey, () =>
    withActivityHeartbeats(`running author sandbox for ${candidate.candidateId}`, (options) =>
      sandbox.run(
        {
          runId: run.runId,
          stage: `author-${candidate.candidateId}`,
          timeoutMs: AUTHORING_TIMEOUT_MS,
          inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
          files: [
            { path: "/work/authoring.ts", contents: extension },
            { path: "/work/selfbench-skill/SKILL.md", contents: skill },
            { path: "/work/sandbox-author.js", contents: compiler },
            { path: "/work/provenance.json", contents: provenance },
            { path: "/work/prompt.txt", contents: prompt },
          ],
          outputPaths: ["/work/source-task.tar.gz", "/work/definition.json"],
          secrets: {
            ...(piAuth.apiKey ? { OPENAI_API_KEY: piAuth.apiKey } : {}),
            ...(piAuth.authJson ? { SELFBENCH_PI_AUTH_JSON: piAuth.authJson } : {}),
            ...(ghToken ? { GH_TOKEN: ghToken } : {}),
          },
          environment: {
            SOURCE_REPO_URL: run.repository.url,
            SOURCE_COMMIT: run.repository.commit,
            AUTHOR_MODEL: run.authoring.model,
            SELFBENCH_TASK_OUTPUT: "/work/tasks",
          },
          command: ["bash", "-lc", authoringScript()],
        },
        options,
      ),
    ),
  );
  const log = await store.put(
    attemptLogKey,
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  const bundle = result.outputs["/work/source-task.tar.gz"];
  const definitionBytes = result.outputs["/work/definition.json"];
  if (result.exitCode !== 0 || !bundle || !definitionBytes) {
    return {
      kind: "rejected",
      candidateId: candidate.candidateId,
      reason: `authoring did not produce a valid ${candidate.difficulty} task; log: ${log.uri}`,
    };
  }
  return await materializeAuthoredTaskDraft(store, run, candidate, definitionBytes, bundle);
}

async function materializeAuthoredTaskDraft(
  store: ArtifactStore,
  run: RunRequest,
  candidate: Candidate,
  definitionBytes: Uint8Array,
  bundle: Uint8Array,
): Promise<TaskAuthorOutcome> {
  const definition = taskDraftDefinitionSchema.parse(
    JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
  );
  if (
    definition.sourcePr !== candidate.sourcePr ||
    definition.sourceUrl !== candidate.sourceUrl ||
    definition.baseCommit !== candidate.baseCommit ||
    definition.difficulty !== candidate.difficulty
  ) {
    return {
      kind: "rejected",
      candidateId: candidate.candidateId,
      reason: "authored task does not match its assigned PR, base commit, and difficulty",
    };
  }
  const [definitionRef, bundleRef] = await Promise.all([
    store.put(
      `runs/${run.runId}/authoring/${candidate.candidateId}/definition.json`,
      definitionBytes,
      "application/json",
    ),
    store.put(
      `runs/${run.runId}/authoring/${candidate.candidateId}/source-task.tar.gz`,
      bundle,
      "application/gzip",
    ),
  ]);
  return {
    kind: "authored",
    task: {
      candidateId: candidate.candidateId,
      taskId: definition.taskId,
      definition: definitionRef,
      sourceBundle: bundleRef,
    },
  };
}
