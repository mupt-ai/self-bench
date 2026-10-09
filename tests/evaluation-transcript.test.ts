import { expect, test } from "bun:test";
import { boundedSteps, piSteps, transcriptSteps } from "../src/evaluation/transcript.js";
import type { SolverStep } from "../src/evaluation/types.js";

const step = (index: number, input: string, output: string): SolverStep => ({
  id: String(index),
  role: "assistant",
  text: `Step ${index}.`,
  tools: [{ id: `t${index}`, name: index === 0 ? "edit" : "bash", input, output }],
});

test("a long run keeps every step and its edit, cutting the tools' output to fit", () => {
  // The first step is the edit; then a hundred commands, each printing 30k characters.
  const steps = [
    step(0, "write src/chunk.rs", "Edited."),
    ...Array.from({ length: 100 }, (_, index) => step(index + 1, "cargo test", "x".repeat(30_000))),
  ];
  const kept = boundedSteps(steps);
  expect(kept).toHaveLength(101);
  expect(kept[0]?.tools[0]).toMatchObject({ input: "write src/chunk.rs", output: "Edited." });
  const size = kept.reduce(
    (total, entry) =>
      total +
      entry.text.length +
      entry.tools.reduce((sum, tool) => sum + tool.input.length + tool.output.length, 0),
    0,
  );
  expect(size).toBeLessThanOrEqual(200_000);
  // A cut output keeps its start and end, and says what was left out.
  const output = kept[50]?.tools[0]?.output ?? "";
  expect(output).toMatch(/^x+\n\[… \d+ characters omitted …\]\nx+$/);
});

test("Pi's last event gives the whole conversation even when only the end of its log was kept", () => {
  const messages = [
    { role: "system", content: "" },
    { role: "user", content: [{ type: "text", text: "Fix the chunks." }] },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.rs" } }],
    },
    { role: "toolResult", toolCallId: "e1", content: [{ type: "text", text: "Edited." }] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ];
  const tail = [
    '[Earlier output truncated]\n"cut":true}',
    JSON.stringify({ type: "message_end", message: messages[4] }),
    JSON.stringify({ type: "agent_end", messages }),
  ].join("\n");
  const steps = piSteps(tail);
  expect(steps.map((entry) => entry.role)).toEqual(["user", "assistant", "assistant"]);
  expect(steps[1]?.tools[0]).toMatchObject({ name: "edit", output: "Edited." });
  // Unfinished, it reads the messages it has.
  expect(piSteps(tail.slice(0, tail.lastIndexOf("\n"))).map((entry) => entry.text)).toEqual([
    "Done.",
  ]);
});

test("a trial's transcript is its trajectory, else Pi's log; a trajectory cut short gives none", () => {
  const trajectory = JSON.stringify({
    steps: [{ step_id: 1, source: "agent", message: "Reading.", tool_calls: [] }],
  });
  expect(
    transcriptSteps(new Map([["solver/t/agent/trajectory.json", trajectory]]))?.[0]?.text,
  ).toBe("Reading.");
  expect(
    transcriptSteps(new Map([["solver/t/agent/trajectory.json", trajectory.slice(0, 20)]])),
  ).toEqual([]);
  expect(transcriptSteps(new Map([["solver/t/trial.log", "log"]]))).toBeUndefined();
});

test("the budget holds however many steps there are, and short limits keep text, not notes", () => {
  const steps = Array.from({ length: 500 }, (_, index) => ({
    id: String(index),
    role: "assistant",
    text: "t".repeat(300),
    tools: Array.from({ length: 30 }, (_, tool) => ({
      id: `${index}-${tool}`,
      name: "bash",
      input: "i".repeat(40),
      output: "o".repeat(2000),
    })),
  }));
  const kept = boundedSteps(steps);
  const size = kept.reduce(
    (total, entry) =>
      total +
      entry.text.length +
      entry.tools.reduce((sum, tool) => sum + tool.input.length + tool.output.length, 0),
    0,
  );
  expect(size).toBeLessThanOrEqual(200_000);
  expect(kept[0]?.text).toMatch(/^t+$/);
});

test("a Pi run that retried keeps its events over an earlier attempt's repeat", () => {
  const user = { role: "user", content: [{ type: "text", text: "Fix it." }] };
  const first = { role: "assistant", content: [{ type: "text", text: "Attempt one." }] };
  const retried = Array.from({ length: 3 }, (_, index) => ({
    role: "assistant",
    content: [{ type: "text", text: `Retry step ${index}.` }],
  }));
  const log = [
    { type: "message_end", message: user },
    { type: "message_end", message: first },
    { type: "agent_end", willRetry: true, messages: [user, first] },
    ...retried.map((message) => ({ type: "message_end", message })),
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  expect(piSteps(log).map((step) => step.text)).toEqual([
    "Fix it.",
    "Attempt one.",
    "Retry step 0.",
    "Retry step 1.",
    "Retry step 2.",
  ]);
});
