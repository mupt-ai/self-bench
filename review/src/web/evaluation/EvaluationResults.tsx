import React from "react";
import { Link } from "react-router";
import { buttonStyles, DataTable, RunStatus } from "../ui";
import type { EvaluationRun, EvaluationTrial } from "./api";
import { TokenCosts } from "./TokenCosts";

export function scores(trial: EvaluationTrial): string {
  const entries = Object.entries(trial.rewards);
  return entries.length
    ? entries.map(([name, value]) => `${name}: ${Number(value.toFixed(4))}`).join(" · ")
    : "Not Scored";
}
export function EvaluationResults({
  run,
  baseUrl,
  repo,
}: {
  run: EvaluationRun;
  baseUrl: string;
  repo: string;
}) {
  const [index, setIndex] = React.useState(0);
  const trial = run.trials[index] ?? run.trials[0];
  const done = run.trials.filter((entry) => entry.status === "completed").length;
  const failed = run.trials.filter((entry) => entry.status === "failed").length;
  const active = run.status === "queued" || run.status === "running";
  const finalMessage = trial?.steps
    .filter((step) => (step.role === "agent" || step.role === "assistant") && step.text)
    .at(-1)?.text;
  return (
    <section className="border border-line bg-surface p-4 sm:p-6" aria-label="Evaluation Results">
      <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center [&_h2]:my-2 [&_p]:font-mono [&_p]:text-base [&_p]:leading-relaxed [&_p]:text-dim">
        <div>
          <span className="font-mono text-sm font-medium tracking-[0.14em] text-mint uppercase">
            {active ? "Live Evaluation" : "Evaluation Results"}
          </span>
          <h2>
            {run.modelLabel} <RunStatus value={run.status} />
          </h2>
          <p>
            {run.sandbox} · {run.harnesses.join(" + ")} · started by {run.startedBy} ·{" "}
            {new Date(run.createdAt).toLocaleString()}
          </p>
          <p>
            Thinking: {run.thinking ?? "Not Recorded"} · Route:{" "}
            {run.credentials?.provider ?? run.modelName.split("/")[0]}
          </p>
        </div>
        <span className="font-mono text-sm whitespace-nowrap text-mint" role="status">
          {done}/{run.trials.length} completed{failed ? ` · ${failed} failed` : ""}
        </span>
      </div>
      {run.error && <p className="my-4 font-mono text-base text-danger">{run.error}</p>}
      <p className="mt-2 text-base text-muted">
        {run.status === "queued"
          ? "Waiting for an evaluation worker. You can leave this page and return later."
          : active
            ? run.sandbox === "docker"
              ? "Updates every 3 seconds. Solver output appears as Harbor writes its mounted logs."
              : "Updates every 3 seconds. Some remote harnesses deliver solver logs after completion; orchestration status is live."
            : "Scores come from the task verifier. A completed trial can score zero; failed trials are not counted as zero."}
      </p>
      <div className="mt-6">
        <DataTable className="min-w-[600px] font-mono [&_tr[data-selected=true]]:bg-surface-3 [&_button]:text-left [&_button]:text-mint [&_button]:wrap-anywhere">
          <thead>
            <tr>
              <th>Task</th>
              <th>Harness</th>
              <th>Status</th>
              <th>Verifier Scores</th>
            </tr>
          </thead>
          <tbody>
            {run.trials.map((entry, trialIndex) => (
              <tr
                key={`${entry.runId}/${entry.taskId}/${entry.harness}`}
                data-selected={trialIndex === index}
              >
                <td>
                  <button
                    type="button"
                    onClick={() => setIndex(trialIndex)}
                    aria-pressed={trialIndex === index}
                  >
                    {entry.taskId}
                  </button>
                </td>
                <td>{entry.harness}</td>
                <td>
                  <RunStatus value={entry.status} />
                </td>
                <td>{scores(entry)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
      {trial && (
        <div>
          <div className="mt-7 mb-3 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center [&_h3]:wrap-anywhere [&_h3_span]:ml-2 [&_h3_span]:font-mono [&_h3_span]:text-sm [&_h3_span]:text-dim">
            <h3>
              {trial.taskId} <span> / {trial.harness}</span>
            </h3>
            <Link
              className={buttonStyles.ghost}
              to={`/repos/${repo}/tasks/${encodeURIComponent(trial.runId)}/${encodeURIComponent(trial.taskId)}`}
            >
              View Task ↗
            </Link>
          </div>
          {trial.error && <p className="my-4 font-mono text-base text-danger">{trial.error}</p>}
          <TokenCosts trial={trial} />
          {!active && finalMessage && (
            <div className="my-5 border-l-2 border-mint bg-surface-2 px-5 pt-px pb-5 [&_p]:text-base [&_p]:leading-relaxed [&_p]:whitespace-pre-wrap [&_p]:wrap-anywhere">
              <h4>Solver’s Final Response</h4>
              <p>{finalMessage}</p>
            </div>
          )}
          <h4>Solver Transcript</h4>
          {!trial.steps.length && (
            <p className="mt-2 text-base text-muted">
              {active
                ? "Waiting for transcript events. Available raw solver and tool output is shown below."
                : "This harness did not produce a readable structured transcript. Inspect the raw output and artifacts below."}
            </p>
          )}
          <ol className="m-0 list-none p-0 [&>li]:border-t [&>li]:border-line [&>li]:py-4.5 [&_p]:text-base [&_p]:leading-relaxed [&_p]:whitespace-pre-wrap [&_p]:wrap-anywhere">
            {trial.steps.map((step, stepIndex) => (
              <li key={step.id}>
                <span className="mb-2.5 block font-mono text-sm text-dim uppercase">
                  {stepIndex + 1} · {step.role}
                </span>
                {step.text && <p>{step.text}</p>}
                {step.tools.map((tool) => (
                  <details key={tool.id}>
                    <summary>{tool.name}</summary>
                    <h5>Input</h5>
                    <pre>{tool.input}</pre>
                    <h5>Output</h5>
                    <pre>{tool.output || "No output captured yet"}</pre>
                  </details>
                ))}
              </li>
            ))}
          </ol>
          <details open={!trial.steps.length}>
            <summary>Harbor and Solver Output</summary>
            <pre>{trial.log || "No output yet."}</pre>
          </details>
          {trial.artifacts.length > 0 && (
            <details className="[&_p]:mt-3 [&_p]:text-base [&_p]:text-dim [&_ul]:list-none [&_ul]:p-0 [&_a]:block [&_a]:py-2 [&_a]:font-mono [&_a]:text-sm [&_a]:text-mint [&_a]:wrap-anywhere">
              <summary>Artifacts · {trial.artifacts.length}</summary>
              <p>Sanitized text exports; large files may be capped at 1 MiB.</p>
              <ul>
                {trial.artifacts.map((name) => (
                  <li key={name}>
                    <a href={`${baseUrl}/${run.id}/artifacts?name=${encodeURIComponent(name)}`}>
                      {name.split("/").slice(2).join("/")}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
