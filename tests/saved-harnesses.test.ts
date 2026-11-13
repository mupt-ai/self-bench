import { afterEach, expect, test } from "bun:test";
import { DEFAULT_SUBAGENT_PROMPT } from "../src/contracts/conditions.js";
import { runCondition } from "../src/evaluation/conditions.js";
import { HARNESSES as harnesses, harnessesWorkspace, send } from "./support/harnesses-fixture.js";

// Saved harnesses: a workspace's named changes to an agent, with the credential that serves its
// subagent model, which a comparison picks by id and runs in each repository environment picked.

const DEEPSEEK = "deepseek-v4-pro-0813";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function workspace() {
  const made = await harnessesWorkspace();
  close = () => made.server.close();
  return made;
}

test("a workspace saves, replaces, and deletes its harnesses, which another workspace cannot read", async () => {
  const { server, save } = await workspace();
  const created = await save({
    name: "Flash Subagents",
    skills: ["vercel/next.js@canary"],
    subagent: { catalogId: DEEPSEEK },
  });
  expect(created.status).toBe(201);
  // Skills are written out as Harbor fetches them, and a subagent model starts on the prompt
  // every such run was told.
  expect(created.harness).toMatchObject({
    name: "Flash Subagents",
    skills: ["https://github.com/vercel/next.js/tree/canary"],
    subagent: { catalogId: DEEPSEEK, prompt: DEFAULT_SUBAGENT_PROMPT },
    createdBy: "avyay",
  });
  const { id } = created.harness as { id: number };
  expect(await save({ name: "flash subagents", instructions: "Other." })).toMatchObject({
    status: 409,
    error: "A harness named flash subagents already exists",
  });
  expect(await save({ name: "Nothing" })).toMatchObject({
    status: 400,
    error: "harness: a harness adds a skill, instructions, options, or a subagent model",
  });
  expect(
    await save({
      name: "Elsewhere",
      subagent: { catalogId: DEEPSEEK, credentialId: crypto.randomUUID() },
    }),
  ).toMatchObject({
    status: 400,
    error: "subagent.credentialId: no such credential in this workspace",
  });
  // A saved harness names no environment: that is the repository's, picked beside it on a run.
  expect((await save({ name: "Scoped", instructions: "x", environment: 1 })).status).toBe(400);
  expect(await save({ name: "Routed", subagent: { catalogId: "dari/routing" } })).toMatchObject({
    status: 400,
    error: "subagent.catalogId: dari/routing is not a model subagents can run on",
  });

  const replaced = await server.request(
    `${harnesses}/${id}`,
    send("PUT", { name: "Quiet Subagents", subagent: { catalogId: DEEPSEEK, prompt: "" } }),
  );
  expect((await replaced.json()).harness).toMatchObject({
    id,
    name: "Quiet Subagents",
    skills: [],
    subagent: { catalogId: DEEPSEEK, prompt: "" },
  });
  const listed = await (await server.request(harnesses)).json();
  expect(listed.harnesses.map((entry: { name: string }) => entry.name)).toEqual([
    "Quiet Subagents",
  ]);
  // Their older address still answers, in their older words.
  const older = await (await server.request("/api/orgs/avyay/conditions")).json();
  expect(older.conditions.map((entry: { id: number }) => entry.id)).toEqual([id]);
  const models = await (await server.request(`${harnesses}/models`)).json();
  expect(models.models.map((model: { id: string }) => model.id)).toContain(DEEPSEEK);
  expect(models.models.map((model: { id: string }) => model.id)).not.toContain("dari/routing");

  // The outsider is no member of this workspace, and their own holds none of its harnesses.
  expect((await server.request(harnesses, {}, 2)).status).toBe(404);
  expect((await server.request(`${harnesses}/${id}`, send("DELETE"), 2)).status).toBe(404);
  const theirs = await (await server.request("/api/orgs/outsider/harnesses", {}, 2)).json();
  expect(theirs.harnesses).toEqual([]);
  const stolen = await server.request(`/api/orgs/outsider/harnesses/${id}`, send("DELETE"), 2);
  expect(stolen.status).toBe(404);

  expect((await server.request(`${harnesses}/${id}`, send("DELETE"))).status).toBe(200);
  expect((await server.request(`${harnesses}/${id}`)).status).toBe(404);
});

test("a saved harness's subagents run where they can, on the credential it names or the first that serves them", async () => {
  const { router, sandbox, credential, save, row, compare } = await workspace();
  const { harness } = await save({
    name: "Flash Subagents",
    instructions: "Read the docs.",
    subagent: { catalogId: DEEPSEEK, prompt: "Delegate the tests." },
  });
  const models = [row("gpt-6-sol", "claude-code"), row("gpt-6-sol", "pi"), row(DEEPSEEK, "codex")];
  const { error, started } = await compare({ models, harnesses: [harness.id] });
  expect(error).toBeUndefined();
  // Every row runs the baseline. The harness runs only where a subagent model changes
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
  // Frozen as served: on the first credential that serves it, since it names none, and told its
  // prompt.
  expect(run?.subagent).toMatchObject({
    catalogId: DEEPSEEK,
    model: `openrouter/deepseek/${DEEPSEEK}`,
    credentialId: router,
    prompt: "Delegate the tests.",
  });
  // The same changes written out are the same in results; a different prompt is another. The
  // credential serving it is no change of its own.
  const written = { skills: [], instructions: "Read the docs." };
  const subagent = { catalogId: DEEPSEEK, prompt: "Delegate the tests." };
  expect(run?.condition?.id).toBe(runCondition({ name: "Any", ...written, subagent }).id);
  expect(run?.condition?.id).not.toBe(
    runCondition({ name: "Any", ...written, subagent: { ...subagent, prompt: "" } }).id,
  );

  // A harness that names its credential runs on it.
  const second = await credential("openrouter", "second");
  const only = { models: [row("gpt-6-sol", "codex")], baseline: false as const };
  const pinned = await save({
    name: "Pinned Subagents",
    subagent: { catalogId: DEEPSEEK, credentialId: second },
  });
  const picked = await compare({ ...only, harnesses: [pinned.harness.id] });
  expect(picked.started.map((input) => input.subagent?.credentialId)).toEqual([second]);
  expect(picked.started[0]?.condition?.id).toBe(
    runCondition({
      name: "Any",
      skills: [],
      subagent: { catalogId: DEEPSEEK, prompt: DEFAULT_SUBAGENT_PROMPT },
    }).id,
  );
  const unservable = await save({
    name: "Sandbox Subagents",
    subagent: { catalogId: DEEPSEEK, credentialId: sandbox },
  });
  expect((await compare({ ...only, harnesses: [unservable.harness.id] })).error).toBe(
    "Sandbox Subagents: Select a subagent model and its matching provider credential",
  );
  // Older clients and retries name the credential beside it, which serves in its place.
  const beside = await compare({
    ...only,
    conditions: [{ saved: harness.id, subagentCredentialId: second }],
  });
  expect(beside.started.map((input) => input.subagent?.credentialId)).toEqual([second]);
  const nowhere = await compare({ models: [row("gpt-6-sol", "pi")], harnesses: [harness.id] });
  expect(nowhere.error).toBe(
    "Flash Subagents sets a subagent model, which only Claude Code and Codex take, and no picked model runs either",
  );
  const alone = await compare({ models: [row(DEEPSEEK, "codex")], harnesses: [harness.id] });
  expect(alone.error).toBe(
    `Flash Subagents runs subagents on ${DEEPSEEK}: pick another model for it to work beside`,
  );
  expect((await compare({ ...only, harnesses: [999_999] })).error).toBe(
    "No saved harness 999999 in this workspace",
  );
});

test("a run takes every pair of its harnesses and environments", async () => {
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
  const { harness } = await save({ name: "With Skills", skills: ["vercel/next.js"] });
  const { error, started } = await compare({
    models: [row("gpt-6-sol", "pi")],
    baseline: false,
    harnesses: [harness.id],
    environments: [built.id],
  });
  expect(error).toBeUndefined();
  expect(started.map((input) => [input.condition?.name, input.tasks[0]?.bundleKey])).toEqual([
    ["With Skills", "tasks/task.tar.gz"],
    ["No AGENTS.md", "runs/scn-variant/harbor-task.tar.gz"],
    ["With Skills · No AGENTS.md", "runs/scn-variant/harbor-task.tar.gz"],
  ]);
  // Each pair is the one its changes written out would be: runs from before harnesses were saved
  // keep counting with them.
  const skills = ["https://github.com/vercel/next.js"];
  expect(started.map((input) => input.condition?.id)).toEqual([
    runCondition({ name: "Any", skills }).id,
    runCondition({ name: "Any", skills: [], environment: built.id }).id,
    runCondition({ name: "Any", skills, environment: built.id }).id,
  ]);
  const twice = await compare({
    models: [row("gpt-6-sol", "pi")],
    harnesses: [harness.id],
    conditions: [{ name: "Same", skills: ["vercel/next.js"] }],
  });
  expect(twice.error).toBe("Pick each harness and environment once");
  const none = await compare({ models: [row("gpt-6-sol", "pi")], baseline: false });
  expect(none.error).toBe("Run the tasks as they are, or pick a harness or an environment");
});

test("a saved harness runs only on the agent it names, with no options to say so", async () => {
  const { save, row, compare } = await workspace();
  const { harness } = await save({ name: "Codex Pack", agent: "codex", skills: ["acme/skills"] });
  const models = [
    row("gpt-6-sol", "claude-code"),
    row("gpt-6-sol", "codex"),
    row("gpt-6-sol", "pi"),
  ];
  const { error, started } = await compare({ models, harnesses: [harness.id] });
  expect(error).toBeUndefined();
  // Claude Code and Pi load skills too, but the harness changes Codex only.
  const scoped = started.filter((input) => input.condition);
  expect(scoped.map((input) => input.harnesses)).toEqual([["codex"]]);
  expect(scoped[0]?.condition?.harness).toBe("codex");
});
