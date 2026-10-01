import type { EvaluationRun, EvaluationTrial } from "./api";
import { TokenCosts } from "./TokenCosts";

const ROLE_LABELS: Record<string, string> = {
  agent: "Agent",
  assistant: "Assistant",
  user: "User",
  system: "System",
  tool: "Tool",
};
const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;

/** One trial's error, model cost, final response, solver transcript, Harbor output and artifacts. */
export function TrialDetails({
  run,
  trial,
  baseUrl,
}: {
  run: EvaluationRun;
  trial: EvaluationTrial;
  baseUrl: string;
}) {
  const active = run.status === "queued" || run.status === "running";
  const finalMessage = trial.steps
    .filter((step) => (step.role === "agent" || step.role === "assistant") && step.text)
    .at(-1)?.text;
  return (
    <div className="[&_h4]:mb-3 [&_h4]:text-sm [&_h4]:font-semibold [&_h5]:my-2 [&_h5]:text-xs [&_h5]:text-muted-foreground [&_details]:mt-3 [&_details]:border [&_details]:border-border [&_details]:bg-background [&_summary]:cursor-pointer [&_summary]:px-4 [&_summary]:py-3 [&_summary]:text-sm [&_summary]:font-medium [&_details_h5]:px-4 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:bg-muted/60 [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-6 [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere">
      {trial.error && <p className="mb-4 text-sm text-destructive">{trial.error}</p>}
      <TokenCosts trial={trial} />
      {!active && finalMessage && (
        <div className="my-5 border-l-2 border-foreground/30 bg-muted/60 p-4 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:whitespace-pre-wrap [&_p]:wrap-anywhere">
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
            <span className="mb-2.5 block text-xs font-semibold text-muted-foreground">
              {stepIndex + 1} · {roleLabel(step.role)}
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
        <summary>Harbor Output</summary>
        {/* Unwrapped so Harbor's result tables keep their columns; the panel scrolls sideways. */}
        <pre className="whitespace-pre!">{trial.log || "No output yet."}</pre>
      </details>
      {trial.artifacts.length > 0 && (
        <details className="[&_p]:mt-3 [&_p]:text-sm [&_p]:text-muted-foreground [&_ul]:list-none [&_ul]:p-0 [&_a]:block [&_a]:py-2 [&_a]:font-mono [&_a]:text-sm [&_a]:text-foreground [&_a]:underline [&_a]:decoration-foreground/25 [&_a]:underline-offset-4 [&_a]:wrap-anywhere [&_a:hover]:decoration-foreground">
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
  );
}
