import { afterEach, expect, test } from "bun:test";
import { DEFAULT_SUBAGENT_PROMPT } from "../src/contracts/conditions.js";
import { runCondition } from "../src/evaluation/conditions.js";
import {
  CONDITIONS as conditions,
  conditionsWorkspace,
  send,
} from "./support/conditions-fixture.js";

// Saved conditions: a workspace's named harness changes, which a comparison picks by id, beside
// a repository environment and the credential that serves its subagent model.

const DEEPSEEK = "deepseek-v4-pro-0813";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function workspace() {
  const made = await conditionsWorkspace();
  close = () => made.server.close();
  return made;
}

test("a workspace saves, replaces, and deletes its conditions, which another workspace cannot read", async () => {
  const { server, save } = await workspace();
  const created = await save({
    name: "Flash Subagents",
    skills: ["vercel/next.js@canary"],
    subagent: { catalogId: DEEPSEEK },
  });
  expect(created.status).toBe(201);
  // Skills are written out as Harbor fetches them, and a subagent model starts on the prompt
  // every such run was told.
  expect(created.condition).toMatchObject({
    name: "Flash Subagents",
    skills: ["https://github.com/vercel/next.js/tree/canary"],
    subagent: { catalogId: DEEPSEEK, prompt: DEFAULT_SUBAGENT_PROMPT },
    createdBy: "avyay",
  });
  const { id } = created.condition as { id: number };
  expect(await save({ name: "flash subagents", instructions: "Other." })).toMatchObject({
    status: 409,
    error: "A condition named flash subagents already exists",
  });
  expect(await save({ name: "Nothing" })).toMatchObject({
    status: 400,
    error:
      "condition: a condition adds a skill, instructions, harness options, or a subagent model",
  });
  // A saved condition names no environment: that is the repository's, picked beside it on a run.
  expect((await save({ name: "Scoped", instructions: "x", environment: 1 })).status).toBe(400);
  expect(await save({ name: "Routed", subagent: { catalogId: "dari/routing" } })).toMatchObject({
    status: 400,
    error: "subagent.catalogId: dari/routing is not a model subagents can run on",
  });

  const replaced = await server.request(
    `${conditions}/${id}`,
    send("PUT", { name: "Quiet Subagents", subagent: { catalogId: DEEPSEEK, prompt: "" } }),
  );
  expect((await replaced.json()).condition).toMatchObject({
    id,
    name: "Quiet Subagents",
    skills: [],
    subagent: { catalogId: DEEPSEEK, prompt: "" },
  });
  const listed = await (await server.request(conditions)).json();
  expect(listed.conditions.map((entry: { name: string }) => entry.name)).toEqual([
    "Quiet Subagents",
  ]);
  const models = await (await server.request(`${conditions}/models`)).json();
  expect(models.models.map((model: { id: string }) => model.id)).toContain(DEEPSEEK);
  expect(models.models.map((model: { id: string }) => model.id)).not.toContain("dari/routing");

  // The outsider is no member of this workspace, and their own holds none of its conditions.
  expect((await server.request(conditions, {}, 2)).status).toBe(404);
  expect((await server.request(`${conditions}/${id}`, send("DELETE"), 2)).status).toBe(404);
  const theirs = await (await server.request("/api/orgs/outsider/conditions", {}, 2)).json();
  expect(theirs.conditions).toEqual([]);
  const stolen = await server.request(`/api/orgs/outsider/conditions/${id}`, send("DELETE"), 2);
  expect(stolen.status).toBe(404);

  expect((await server.request(`${conditions}/${id}`, send("DELETE"))).status).toBe(200);
  expect((await server.request(`${conditions}/${id}`)).status).toBe(404);
});

test("a saved condition's subagents run where they can, on the credential picked or the first that serves them", async () => {
  const { router, sandbox, credential, save, row, compare } = await workspace();
  const { condition } = await save({
    name: "Flash Subagents",
    instructions: "Read the docs.",
    subagent: { catalogId: DEEPSEEK, prompt: "Delegate the tests." },
  });
  const models = [row("gpt-6-sol", "claude-code"), row("gpt-6-sol", "pi"), row(DEEPSEEK, "codex")];
  const { error, started } = await compare({ models, conditions: [{ saved: condition.id }] });
  expect(error).toBeUndefined();
  // Every row runs the baseline. The condition runs only where a subagent model changes
  // something: not on Pi, which takes none, and not on the row that is the subagent model.
  const delegating = started.filter((input) => input.condition);
  expect(started.filter((input) => !input.condition)).toHaveLength(3);
  expect(delegating.map((input) => [input.model, input.harnesses])).toEqual([
    ["gpt-6-sol", ["claude-code"]],
  ]);
  const [run] = delegating;
  expect(run?.condition).toMatchObject({
    name: "Flash Subagents",
    instructions: "Read the docs.",
    subagent: { catalogId: DEEPSEEK, prompt: "Delegate the tests." },
  });
  // Frozen as served: on the first credential that serves it, and told the condition's prompt.
  expect(run?.subagent).toMatchObject({
    catalogId: DEEPSEEK,
    model: `openrouter/deepseek/${DEEPSEEK}`,
    credentialId: router,
    prompt: "Delegate the tests.",
  });
  // The same changes written out are the same condition, so results count them together; a
  // different prompt is another.
  const written = { skills: [], instructions: "Read the docs." };
  const subagent = { catalogId: DEEPSEEK, prompt: "Delegate the tests." };
  expect(run?.condition?.id).toBe(runCondition({ name: "Any", ...written, subagent }).id);
  expect(run?.condition?.id).not.toBe(
    runCondition({ name: "Any", ...written, subagent: { ...subagent, prompt: "" } }).id,
  );

  const second = await credential("openrouter", "second");
  const only = { models: [row("gpt-6-sol", "codex")], baseline: false as const };
  const picked = await compare({
    ...only,
    conditions: [{ saved: condition.id, subagentCredentialId: second }],
  });
  expect(picked.started.map((input) => input.subagent?.credentialId)).toEqual([second]);
  const unserved = await compare({
    ...only,
    conditions: [{ saved: condition.id, subagentCredentialId: sandbox }],
  });
  expect(unserved.error).toBe(
    "Flash Subagents: Select a subagent model and its matching provider credential",
  );
  const nowhere = await compare({
    models: [row("gpt-6-sol", "pi")],
    conditions: [{ saved: condition.id }],
  });
  expect(nowhere.error).toBe(
    "Flash Subagents sets a subagent model, which only Claude Code and Codex take, and no picked model runs either",
  );
  const alone = await compare({
    models: [row(DEEPSEEK, "codex")],
    conditions: [{ saved: condition.id }],
  });
  expect(alone.error).toBe(
    `Flash Subagents runs subagents on ${DEEPSEEK}: pick another model for it to work beside`,
  );
  expect((await compare({ ...only, conditions: [{ saved: 999_999 }] })).error).toBe(
    "No saved condition 999999 in this workspace",
  );
});

test("a run pairs a saved condition with a repository environment, or names the environment alone", async () => {
  const { server, save, row, compare } = await workspace();
  const task = await server.tasks.find(server.repo.id, "run-one", "task-one");
  if (!task) throw new Error("Missing fixture task");
  const built = await server.tasks.variants.createEnvironment({
    repoId: server.repo.id,
    name: "No AGENTS.md",
    script: "rm -f AGENTS.md",
    createdBy: server.user.id,
  });
  const variant = await server.tasks.variants.reserve({
    environmentId: built.id,
    parentId: task.id,
    repoId: server.repo.id,
    runId: "scn-variant",
    candidateId: task.candidateId,
    taskId: task.taskId,
    startedBy: server.user.id,
  });
  await server.tasks.variants.settle(variant.runId, variant.candidateId, {
    pipelineStatus: "accepted",
    stage: "accepted",
    bundleKey: "runs/scn-variant/harbor-task.tar.gz",
  });
  const { condition } = await save({ name: "With Skills", skills: ["vercel/next.js"] });
  const { error, started } = await compare({
    models: [row("gpt-6-sol", "pi")],
    baseline: false,
    conditions: [
      { saved: condition.id },
      { saved: condition.id, environment: built.id },
      { environment: built.id },
    ],
  });
  expect(error).toBeUndefined();
  expect(started.map((input) => [input.condition?.name, input.tasks[0]?.bundleKey])).toEqual([
    ["With Skills", "tasks/task.tar.gz"],
    ["With Skills · No AGENTS.md", "runs/scn-variant/harbor-task.tar.gz"],
    ["No AGENTS.md", "runs/scn-variant/harbor-task.tar.gz"],
  ]);
  // Three conditions in results, each the one its changes written out would be: runs from before
  // conditions were saved keep counting with them.
  const skills = ["https://github.com/vercel/next.js"];
  expect(started.map((input) => input.condition?.id)).toEqual([
    runCondition({ name: "Any", skills }).id,
    runCondition({ name: "Any", skills, environment: built.id }).id,
    runCondition({ name: "Any", skills: [], environment: built.id }).id,
  ]);
  const twice = await compare({
    models: [row("gpt-6-sol", "pi")],
    conditions: [{ saved: condition.id }, { name: "Same", skills: ["vercel/next.js"] }],
  });
  expect(twice.error).toBe("Pick each condition once");
});

test("a saved condition runs only on the harness it names, with no options to say so", async () => {
  const { save, row, compare } = await workspace();
  const { condition } = await save({
    name: "Codex Pack",
    harness: "codex",
    skills: ["acme/skills"],
  });
  const models = [
    row("gpt-6-sol", "claude-code"),
    row("gpt-6-sol", "codex"),
    row("gpt-6-sol", "pi"),
  ];
  const { error, started } = await compare({ models, conditions: [{ saved: condition.id }] });
  expect(error).toBeUndefined();
  // Claude Code and Pi load skills too, but the condition changes Codex only.
  const scoped = started.filter((input) => input.condition);
  expect(scoped.map((input) => input.harnesses)).toEqual([["codex"]]);
  expect(scoped[0]?.condition?.harness).toBe("codex");
});
