import React from "react";
import { Link } from "react-router";
import { harnessLabels } from "../../../../src/evaluation/harnesses";
import { buttonStyles, DataTable, Notice, RunStatus } from "../ui";
import type { EvaluationRun, EvaluationTrial } from "./api";
import { thinkingLabel } from "./run-presentation";
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
    <section
      className="border border-border bg-card p-4 sm:p-6 [&_h4]:mb-3 [&_h4]:text-sm [&_h4]:font-medium [&_h5]:my-2 [&_h5]:text-xs [&_h5]:text-muted-foreground [&_details]:mt-3 [&_details]:border [&_details]:border-border [&_summary]:cursor-pointer [&_summary]:px-4 [&_summary]:py-3 [&_summary]:text-sm [&_details_h5]:px-4 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:bg-background [&_pre]:p-4 [&_pre]:text-xs [&_pre]:leading-6 [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere"
      aria-label="Evaluation Results"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-3 text-sm font-medium">
            {run.modelLabel} <RunStatus value={run.status} />
          </h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {run.sandbox} · {run.harnesses.map((harness) => harnessLabels[harness]).join(" + ")} ·
            started by {run.startedBy} · {new Date(run.createdAt).toLocaleString()}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Thinking: {thinkingLabel(run.thinking)} · Route:{" "}
            {run.credentials?.provider ?? run.modelName.split("/")[0]}
          </p>
        </div>
        <span className="text-xs text-muted-foreground" role="status">
          {done}/{run.trials.length} completed{failed ? ` · ${failed} failed` : ""}
        </span>
      </header>
      {run.error && <Notice className="mt-4">{run.error}</Notice>}
      {active && (
        <div className="mt-4 border-l-2 border-brand bg-brand/5 px-4 py-3" role="status">
          <p className="text-sm font-medium">
            {run.status === "queued" ? "Queued" : "Running Now"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {run.status === "queued"
              ? "Waiting for an evaluation worker."
              : (run.trials.find((entry) => entry.status === "running")?.taskId ??
                "Preparing the evaluation environment…")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {run.trials.filter((entry) => entry.status === "queued").length} tasks queued · {done}{" "}
            completed{failed ? ` · ${failed} failed` : ""}
          </p>
        </div>
      )}
      <div className="mt-6">
        <DataTable className="min-w-[600px] font-mono [&_tr[data-selected=true]]:bg-accent [&_button]:text-left [&_button]:text-brand [&_button]:wrap-anywhere">
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
                <td>{harnessLabels[entry.harness]}</td>
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
          <div className="mt-6 mb-4 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center [&_h3]:wrap-anywhere [&_h3_span]:ml-2 [&_h3_span]:font-mono [&_h3_span]:text-sm [&_h3_span]:text-muted-foreground">
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
          {trial.error && <p className="my-4 font-mono text-sm text-destructive">{trial.error}</p>}
          <TokenCosts trial={trial} />
          {!active && finalMessage && (
            <div className="my-5 border-l-2 border-brand bg-muted/40 p-4 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:whitespace-pre-wrap [&_p]:wrap-anywhere">
              <h4>Solver’s Final Response</h4>
              <p>{finalMessage}</p>
            </div>
          )}
          <h4>Solver Transcript</h4>
          {!trial.steps.length && (
            <p className="mt-2 text-sm text-muted-foreground">
              {active
                ? "Waiting for transcript events. Available raw solver and tool output is shown below."
                : "This harness did not produce a readable structured transcript. Inspect the raw output and artifacts below."}
            </p>
          )}
          <ol className="m-0 list-none p-0 [&>li]:border-t [&>li]:border-border [&>li]:py-4 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:whitespace-pre-wrap [&_p]:wrap-anywhere">
            {trial.steps.map((step, stepIndex) => (
              <li key={step.id}>
                <span className="mb-2.5 block font-mono text-sm text-muted-foreground uppercase">
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
            <details className="[&_p]:mt-3 [&_p]:text-sm [&_p]:text-muted-foreground [&_ul]:list-none [&_ul]:p-0 [&_a]:block [&_a]:py-2 [&_a]:font-mono [&_a]:text-sm [&_a]:text-brand [&_a]:wrap-anywhere">
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
