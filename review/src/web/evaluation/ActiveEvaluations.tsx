import { Link } from "react-router";
import { harnessLabels } from "../../../../src/evaluation/harnesses";
import type { EvaluationRun } from "./api";
import { thinkingLabel } from "./run-presentation";

export function ActiveEvaluations({ runs, repo }: { runs: EvaluationRun[]; repo: string }) {
  const active = runs.filter((run) => run.status === "running");
  const queued = runs.filter((run) => run.status === "queued");
  if (!active.length && !queued.length) return null;
  return (
    <section className="mb-6 border border-border bg-card" aria-label="Run Activity">
      <header className="flex items-center justify-between border-b border-border px-4 py-3 text-sm">
        <h2 className="font-medium">Run Activity</h2>
        <span className="text-xs text-muted-foreground">
          {active.length} running · {queued.length} queued
        </span>
      </header>
      {active.map((run) => (
        <Link
          key={run.id}
          to={`/repos/${repo}/results?run=${run.id}`}
          className="block border-l-2 border-brand bg-brand/5 px-4 py-4 hover:bg-brand/10"
        >
          <span className="text-xs text-brand">Running Now</span>
          <p className="mt-1 text-sm">
            {run.modelLabel} · {run.harnesses.map((harness) => harnessLabels[harness]).join(" + ")}{" "}
            · Thinking: {thinkingLabel(run.thinking)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {run.trials.find((trial) => trial.status === "running")?.taskId ??
              "Preparing the evaluation environment…"}
          </p>
        </Link>
      ))}
      {queued.map((run) => (
        <Link
          key={run.id}
          to={`/repos/${repo}/results?run=${run.id}`}
          className="flex flex-wrap justify-between gap-2 border-t border-border px-4 py-3 text-sm hover:bg-muted"
        >
          <span>
            {run.modelLabel} · {run.harnesses.map((harness) => harnessLabels[harness]).join(" + ")}
          </span>
          <span className="text-xs text-muted-foreground">
            Thinking: {thinkingLabel(run.thinking)} · Queued
          </span>
        </Link>
      ))}
    </section>
  );
}
