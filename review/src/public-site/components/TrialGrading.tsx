import { Check, Minus, X } from "lucide-react";
import type { PublicTrial } from "../contract";

/**
 * The verifier's checks, in the order it runs them (src/generation/task/verifier.ts). A trial
 * passes only when all four do. Each but the first records its command's exit code, -1 when an
 * earlier check failing kept it from running.
 */
const CHECKS = [
  {
    key: "patch_applied",
    label: "Patch Applied",
    detail: "The solver's changes applied, with the task's held-out tests over them.",
  },
  {
    key: "fail_to_pass",
    exit: "fail_to_pass_exit_code",
    label: "New Tests Pass",
    detail: "The pull request's tests, which fail without its change.",
  },
  {
    key: "deterministic",
    exit: "fail_to_pass_repeat_exit_code",
    label: "New Tests Pass Again",
    detail: "The same tests run a second time, so a lucky pass does not count.",
  },
  {
    key: "pass_to_pass",
    exit: "pass_to_pass_exit_code",
    label: "Existing Tests Pass",
    detail: "Tests that passed before the change, which must still pass.",
  },
] as const;

type CheckState = "passed" | "failed" | "skipped";

const MARKS: Record<CheckState, { icon: typeof Check; tone: string; label: string }> = {
  passed: { icon: Check, tone: "text-(--ok)", label: "Passed" },
  failed: { icon: X, tone: "text-(--bad)", label: "Failed" },
  skipped: { icon: Minus, tone: "text-muted-foreground", label: "Not Run" },
};

/**
 * How the verifier graded a trial: each check it ran, with its exit code, and what the tests
 * printed. Trials from verifiers without these checks show their test output alone.
 */
export function TrialGrading({ trial }: { trial: PublicTrial }) {
  const checks = CHECKS.flatMap((check) => {
    const value = trial.rewards[check.key];
    if (value === undefined) return [];
    const exit = "exit" in check ? trial.rewards[check.exit] : undefined;
    const state: CheckState = value === 1 ? "passed" : exit === -1 ? "skipped" : "failed";
    return [{ ...check, state, exit }];
  });
  if (checks.length === 0 && !trial.verifierOutput) return null;
  return (
    <section aria-labelledby="grading-title" className="mb-6">
      <h4 id="grading-title" className="mb-3 text-sm font-semibold">
        Grading
      </h4>
      {checks.length > 0 && (
        <ol className="divide-y divide-border border border-border bg-background">
          {checks.map((check) => {
            const mark = MARKS[check.state];
            const Icon = mark.icon;
            return (
              <li key={check.key} className="flex items-start gap-3 px-4 py-2.5">
                <Icon
                  aria-label={mark.label}
                  className={`mt-0.5 size-4 shrink-0 ${mark.tone}`}
                  strokeWidth={2.5}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{check.label}</span>
                  <span className="block text-xs text-muted-foreground">{check.detail}</span>
                </span>
                {check.exit !== undefined && check.exit !== -1 && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    exit {check.exit}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {trial.verifierOutput && (
        <details className="mt-3 border border-border bg-background">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Test Output</summary>
          {/* Unwrapped so test runners' tables keep their columns; the box scrolls sideways. */}
          <pre className="max-h-96 overflow-auto bg-muted/60 p-4 font-mono text-xs leading-6 whitespace-pre">
            {trial.verifierOutput}
          </pre>
        </details>
      )}
    </section>
  );
}
