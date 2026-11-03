import { expect, test } from "bun:test";
import { saveEvaluation } from "../src/evaluation/store.js";
import {
  create,
  fixture,
  groupRun,
  groupSuite,
  json,
  REPOS,
  request,
} from "./support/group-fixture.js";

groupSuite();

test("members' own runs count in the group's results and releases, marked with their repository", async () => {
  await create();
  const [flask, django] = REPOS;
  // Luna ran on each repository on its own, never from the group.
  await saveEvaluation(
    fixture.artifacts,
    groupRun({ repoId: flask?.repoId ?? 0 }, "luna", { 11: ["t1"] }, [11]),
  );
  await saveEvaluation(
    fixture.artifacts,
    groupRun({ repoId: django?.repoId ?? 0 }, "luna", { 22: ["t1", "t2"] }, [22]),
  );
  // Another model ran on one repository only, so the group never has it on every task.
  await saveEvaluation(
    fixture.artifacts,
    groupRun({ repoId: flask?.repoId ?? 0 }, "terra", { 11: ["t1"] }, [11]),
  );
  const { runs } = await json<{ runs: { id: string; sourceRepository?: string }[] }>(
    "/api/orgs/acme/groups/python-web/evaluations",
  );
  expect(runs.map((run) => run.sourceRepository).sort()).toEqual([
    "django/django",
    "pallets/flask",
    "pallets/flask",
  ]);
  const opened = await json<{ sourceRepository?: string }>(
    `/api/orgs/acme/groups/python-web/evaluations/${runs[0]?.id}`,
  );
  expect(opened.sourceRepository).toBeDefined();
  // Managed from its repository: the group cannot delete it.
  const deleted = await request(
    `/api/orgs/acme/groups/python-web/evaluations/${runs[0]?.id}/delete`,
    {
      method: "POST",
    },
  );
  expect(deleted.status).toBe(404);

  const view = await json<{ preview: { settings: { key: string; coverage: number[] }[] } }>(
    "/api/orgs/acme/groups/python-web/releases/preview",
  );
  const coverage = view.preview.settings.map((setting) => setting.coverage.length).sort();
  // Luna covers all 4 tasks from the two members' runs; terra only flask's 2.
  expect(coverage).toEqual([2, 4]);
});
