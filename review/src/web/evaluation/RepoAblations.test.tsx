import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { EnvironmentItem } from "../environments/environment-api";
import { type AblationPick, ablationPick } from "./RepoAblations";
import type { RunDraft } from "./RunExecution";
import { RunTaskPicker } from "./RunTaskPicker";
import { environment, inBrowser } from "./run-harness-fixture";

type Picks = Pick<RunDraft, "environments" | "baseline">;
const second: EnvironmentItem = { ...environment, id: 9, name: "No Docs" };

test("the Tasks box picks repo ablations, and whether the original tasks run beside them", async () => {
  let latest: Picks = {};
  function Picker() {
    const [draft, setDraft] = useState<Picks>({});
    latest = draft;
    return (
      <MemoryRouter>
        <RunTaskPicker
          scope={{ kind: "repository", repo: "owner/repo", pages: "/repos/owner/repo" }}
          availableTasks={[]}
          picked={[]}
          tasksReady
          disabled={false}
          onChange={() => undefined}
          ablations={ablationPick(draft, [environment, second], setDraft)}
        />
      </MemoryRouter>
    );
  }
  await inBrowser(async (_browser, container) => {
    const root = createRoot(container);
    await act(async () => root.render(<Picker />));
    const box = (label: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`) ?? undefined;
    expect(container.querySelector('fieldset[aria-label="Repo Ablations"]')).not.toBeNull();
    // The old box, and its list of harnesses, are gone: a harness is each model row's own.
    expect(container.textContent).not.toContain("Harnesses and Repo Ablations");
    expect(container.querySelector('fieldset[aria-label="Harnesses"]')).toBeNull();
    // Nothing to leave out until a repo ablation is picked.
    expect(box("Original Tasks")).toBeUndefined();
    await act(async () => box("No AGENTS.md")?.click());
    expect(latest).toEqual({ environments: [7] });
    await act(async () => box("Original Tasks")?.click());
    expect(latest).toEqual({ environments: [7], baseline: false });
    await act(async () => box("No Docs")?.click());
    expect(latest).toEqual({ environments: [7, 9], baseline: false });
    // Unpicking the last one runs the original tasks again: there is nothing else to run.
    await act(async () => box("No AGENTS.md")?.click());
    await act(async () => box("No Docs")?.click());
    expect(latest).toEqual({});
    await act(async () => root.unmount());
  });
});

test("the Tasks box shows no repo ablations where there are none, and keeps a deleted pick to unpick", () => {
  const render = (ablations?: AblationPick) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <RunTaskPicker
          scope={{ kind: "benchmark", repo: undefined, pages: "/evals/x" }}
          availableTasks={[]}
          picked={[]}
          tasksReady
          disabled={false}
          onChange={() => undefined}
          {...(ablations ? { ablations } : {})}
        />
      </MemoryRouter>,
    );
  // A benchmark or a group has no repo ablations; a repository with none shows no line.
  expect(render()).not.toContain("Repo Ablations");
  expect(render(ablationPick({}, [], () => undefined))).not.toContain("Repo Ablations");
  expect(render(ablationPick({ environments: [8] }, [environment], () => undefined))).toContain(
    "Deleted (8)",
  );
  // While the list loads, or when it could not, a pick still shows, with Original Tasks, so
  // nothing runs unseen.
  const loading = render(
    ablationPick({ environments: [8], baseline: false }, undefined, () => undefined),
  );
  expect(loading).toContain("Repo Ablation 8");
  expect(loading).toContain("Original Tasks");
  expect(render(ablationPick({}, undefined, () => undefined))).not.toContain("Repo Ablations");
});
