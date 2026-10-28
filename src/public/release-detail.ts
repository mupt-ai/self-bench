import type { CredentialFacts } from "./release-results.js";
import type { Candidate } from "./release-rule.js";

/** Private per-setting detail: routes, pricing, token sums, and trial dates. */
export function detailOf(
  entry: Candidate,
  tasks: readonly string[],
  credentials: ReadonlyMap<string, CredentialFacts>,
) {
  const chosen = tasks.flatMap((task) => {
    const result = entry.results.get(task);
    return result ? [result] : [];
  });
  const sum = (field: "input" | "output" | "cacheRead" | "cacheWrite") =>
    chosen.reduce((total, result) => total + (result.trial.tokenUsage?.[field] ?? 0), 0);
  const times = chosen.flatMap((result) =>
    result.trial.finishedAt ? [result.trial.finishedAt] : [],
  );
  times.sort();
  const latestRun = chosen
    .map((result) => result.run)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  return {
    routes: chosen.map(({ run }) => ({
      evaluationId: run.id,
      provider: run.credentials?.provider,
      signIn: credentials.get(run.credentials?.modelCredentialId ?? "")?.auth,
      endpoint: credentials.get(run.credentials?.modelCredentialId ?? "")?.endpoint,
    })),
    sandbox: latestRun?.sandbox,
    pricing: latestRun?.pricing,
    tokens: {
      input: sum("input"),
      output: sum("output"),
      cacheRead: sum("cacheRead"),
      cacheWrite: sum("cacheWrite"),
    },
    firstTrialAt: times[0],
    lastTrialAt: times.at(-1),
  };
}
