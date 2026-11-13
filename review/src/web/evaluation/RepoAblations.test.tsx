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

test("past six repo ablations, the Tasks box picks them from a searchable list, up to the limit", async () => {
  const many = Array.from({ length: 8 }, (_, at) => ({
    ...environment,
    id: 100 + at,
    name: `Ablation ${at}`,
  }));
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
          ablations={ablationPick(draft, many, setDraft)}
        />
      </MemoryRouter>
    );
  }
  // Rendered as it opens: a trigger that counts, and no checkbox per ablation.
  const closed = renderToStaticMarkup(
    <MemoryRouter>
      <RunTaskPicker
        scope={{ kind: "repository", repo: "owner/repo", pages: "/repos/owner/repo" }}
        availableTasks={[]}
        picked={[]}
        tasksReady
        disabled={false}
        onChange={() => undefined}
        ablations={ablationPick({}, many, () => undefined)}
      />
    </MemoryRouter>,
  );
  expect(closed).toContain("None of 8 Picked");
  expect(closed).not.toContain('aria-label="Ablation 0"');
  await inBrowser(async (browser, container) => {
    const root = createRoot(container);
    await act(async () => root.render(<Picker />));
    const trigger = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Repo Ablations"]');
    const options = () =>
      [...browser.document.querySelectorAll('[role="option"]')] as unknown as HTMLButtonElement[];
    const toggle = async (name: string) => {
      // The list stays open after a pick, so only a closed one is opened.
      if (!browser.document.querySelector('[role="listbox"]'))
        await act(async () => trigger()?.click());
      const option = options().find((entry) => entry.textContent?.startsWith(name));
      if (!option) throw new Error(`Missing ${name}`);
      await act(async () => option.click());
    };
    await toggle("Ablation 0");
    await toggle("Ablation 3");
    expect(latest.environments).toEqual([100, 103]);
    // The list stays open while a run of picks is made, and the trigger names them.
    expect(options().length).toBe(8);
    expect(trigger()?.textContent).toBe("Ablation 0, Ablation 3");
    await toggle("Ablation 5");
    await toggle("Ablation 6");
    // At the limit, the rest cannot be picked.
    const rest = options().find((entry) => entry.textContent?.startsWith("Ablation 7"));
    expect(rest?.disabled).toBe(true);
    await toggle("Ablation 0");
    expect(latest.environments).toEqual([103, 105, 106]);
    await act(async () => root.unmount());
  });
});
