import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { EvaluationRun } from "./api";
import { ConfigurationRows } from "./ResultsConfigurationRows";
import { ResultsStatus } from "./ResultsMarks";
import { ResultsTable } from "./ResultsTable";
import { missingTasks, unsolvedOf } from "./results-coverage";
import { at, credentials, errored, NOW, passed, run, type TrialSpec } from "./results-fixture";
import { configurationsOf } from "./results-model";
import { momentLabel } from "./results-presentation";

test("a batch's circle fills once it's done, and turns red only when a task errored", () => {
  const circle = (status: EvaluationRun["status"], trials: TrialSpec[]) => {
    const [configuration] = configurationsOf([run("r", { status }, trials)], credentials, NOW);
    return renderToStaticMarkup(
      <ResultsStatus results={configuration?.batches[0]?.results ?? []} />,
    );
  };
  const running = { taskId: "task-2", status: "running", startedAt: at(5) } as const;
  const error = errored("task-3", "Harbor exited with code 137");
  expect(circle("completed", [passed("task-1")])).toMatch(
    /text-success".*r="4.25" fill="currentColor"/,
  );
  expect(circle("completed", [passed("task-1")])).toContain(">Done<");
  expect(circle("running", [passed("task-1"), running])).toContain(">Running<");
  expect(circle("running", [passed("task-1"), running])).toContain('r="4.25" fill="none"');
  expect(circle("running", [error, running])).toContain(">Running with Errors<");
  const failed = { ...passed("task-4"), rewards: { reward: 0 } };
  // A task the model didn't solve is a result, not a problem.
  expect(circle("completed", [passed("task-1"), failed])).toContain(">Done<");
  expect(circle("completed", [passed("task-1"), failed])).toMatch(
    /text-success".*r="4.25" fill="currentColor"/,
  );
  expect(circle("failed", [failed, error])).toContain(">Done with Errors<");
  expect(circle("failed", [failed, error])).toMatch(
    /text-destructive".*r="4.25" fill="currentColor"/,
  );
  expect(circle("queued", [{ taskId: "task-1" }])).toContain(">Queued<");
});

test("the table starts closed, opening to batches and then to tasks", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ResultsTable
        runs={[run("one", {}, [passed("earendil-works-pi-pr-7371-unix-client-transport")])]}
        credentials={credentials}
        baseUrl="/api/evaluations"
        repo="owner/repo"
      />
    </MemoryRouter>,
  );
  for (const text of [
    ">Configurations<",
    ">GPT-6<",
    "high · Codex · OpenAI API Key",
    ">Done<",
    ">1/1<",
    ">100%<",
    'aria-expanded="false"',
  ]) {
    expect(html).toContain(text);
  }
  // Every task passed or failed, so no asterisk beside the count.
  expect(html).not.toContain("finished:");
  // Closed: no batch or task rows yet, and no alerts or flags anywhere.
  for (const text of ["started by", "PR #7371", "Flags", "Needs Attention"]) {
    expect(html).not.toContain(text);
  }
});

test("an open configuration lists its cumulative results, then its five newest runs, then more", () => {
  const runs = Array.from({ length: 7 }, (_, index) =>
    run(`run-${index}`, { comparisonId: `c${index}`, createdAt: at(700 - index * 60) }, [
      passed("task-1"),
    ]),
  );
  const [configuration] = configurationsOf(runs, credentials, NOW);
  if (!configuration) throw new Error("No configuration");
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <table>
        <tbody>
          <ConfigurationRows
            configuration={configuration}
            accepted={[
              { runId: "batch-1", taskId: "task-1", difficulty: "easy" },
              // Accepted before the last run, which left it out.
              { runId: "batch-1", taskId: "task-2", difficulty: "easy", acceptedAt: at(9999) },
              // Accepted after the last run.
              { runId: "batch-1", taskId: "task-3", difficulty: "easy", acceptedAt: at(1) },
            ]}
            unsolved={new Map()}
            view={{
              states: [],
              facets: {},
              configurations: [configuration.key],
              batches: [],
              shown: {},
              sorts: {},
              runLimits: {},
            }}
            setView={() => {}}
            onOpenTask={() => {}}
          />
        </tbody>
      </table>
    </MemoryRouter>,
  );
  expect(html).toContain("Cumulative Results");
  // Two accepted tasks never ran: one left out, one accepted since.
  expect(html).toContain("1 passed · 1 left out · 1 added later");
  expect(html.match(/Show Tasks for the [^"]* Run"/g)).toHaveLength(5);
  // Newest first: the last run listed is the third newest of the seven.
  const labels = [...html.matchAll(/Show Tasks for the ([^"]*) Run"/g)].map((match) => match[1]);
  expect(labels[0]).toBe(momentLabel(at(700 - 6 * 60)));
  expect(html).toContain("Show 2 Earlier Runs");
});

test("a task accepted before a re-run of old tasks, but after the last new ones, was added later", () => {
  const full = run("full", { comparisonId: "c1", createdAt: at(300) }, [
    passed("task-1"),
    errored("task-2", "Harbor exited with code 137"),
  ]);
  const retry = run("retry", { comparisonId: "c2", createdAt: at(100) }, [passed("task-2")]);
  const pick = run("pick", { comparisonId: "c3", createdAt: at(50) }, [passed("task-3")]);
  const accepted = (taskId: string, minutesAgo: number) => ({
    runId: "batch-1",
    taskId,
    difficulty: "easy",
    acceptedAt: at(minutesAgo),
  });
  // Accepted between the full run and the retry of its error: no run of new tasks since.
  const [retried] = configurationsOf([full, retry], credentials, NOW);
  if (!retried) throw new Error("No configuration");
  expect(missingTasks(retried, [accepted("task-9", 200)])[0]?.outcome).toBe("added");
  // Then a run of new tasks that didn't include it: left out.
  const [picked] = configurationsOf([full, retry, pick], credentials, NOW);
  if (!picked) throw new Error("No configuration");
  expect(missingTasks(picked, [accepted("task-9", 200)])[0]?.outcome).toBe("unrun");
});

test("an accepted task three configurations ran and none passed is flagged Unsolved", () => {
  const failed = (taskId: string): TrialSpec => ({ ...passed(taskId), rewards: { reward: 0 } });
  const unverified = (taskId: string): TrialSpec => ({ ...failed(taskId), modelVerified: false });
  const runs = [
    run("low", { thinking: "low" }, [failed("task-1"), failed("task-2"), failed("task-3")]),
    run("medium", { thinking: "medium" }, [failed("task-1"), passed("task-2"), failed("task-3")]),
    run("high", { thinking: "high" }, [failed("task-1"), failed("task-2"), unverified("task-3")]),
    run("custom", { credential: "gpu-a" }, [failed("task-4")]),
  ];
  const configurations = configurationsOf(runs, credentials, NOW);
  const accepted = ["task-1", "task-2", "task-3"].map((taskId) => ({
    runId: "batch-1",
    taskId,
    difficulty: "easy",
  }));
  // task-2 was passed once, and task-3 has only two usable results.
  const unsolved = unsolvedOf(configurations, accepted);
  expect([...unsolved]).toEqual([["batch-1/task-1", 3]]);
  // Only accepted tasks count.
  expect(unsolvedOf(configurations, []).size).toBe(0);

  const configuration = configurations.find((entry) => entry.thinking === "low");
  if (!configuration) throw new Error("No configuration");
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <table>
        <tbody>
          <ConfigurationRows
            configuration={configuration}
            accepted={accepted}
            unsolved={unsolved}
            view={{
              states: [],
              facets: {},
              configurations: [configuration.key],
              batches: [`${configuration.key}\nlatest`],
              shown: {},
              sorts: {},
              runLimits: {},
            }}
            setView={() => {}}
            onOpenTask={() => {}}
          />
        </tbody>
      </table>
    </MemoryRouter>,
  );
  expect(html.match(/>Unsolved</g)).toHaveLength(1);
  expect(html).toContain(
    "None of the 3 configurations with an eligible result on this task passed it.",
  );
});
