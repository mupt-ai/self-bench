import { z } from "zod";
import { MAX_CONDITIONS, MAX_PICKED } from "../../../../src/contracts/conditions";
import { thinkingLevels } from "../../../../src/contracts/models";
import { harnessIds } from "../../../../src/evaluation/models";
import { evaluationRequestId } from "./api";

const tasksSchema = z.array(
  z.object({ runId: z.string().min(1).max(100), taskId: z.string().min(1).max(200) }),
);
const pickedIds = z.array(z.number().int().positive()).max(MAX_PICKED).optional().catch(undefined);
/** A saved Run draft: its tasks, models, where they run, and its LLM judge's credential. */
const draftStateSchema = z.object({
  submitted: z.boolean(),
  sandboxDefaultPending: z.boolean().optional(),
  draft: z.object({
    id: z.uuid(),
    // Drafts saved before benchmarks picked tasks have none; the Run page then picks them all.
    tasks: tasksSchema.default([]),
    models: z
      .array(
        z.object({
          catalogId: z.string().max(200),
          credentialId: z.string().max(36),
          thinking: z.enum(thinkingLevels).optional(),
          customModel: z.string().max(200).optional(),
          harnesses: z.array(z.enum(harnessIds)).max(harnessIds.length),
        }),
      )
      .max(12),
    sandbox: z.enum(["managed", "e2b", "modal", "daytona"]),
    sandboxCredentialId: z.string().max(36),
    skipCompleted: z.boolean().optional(),
    judgeCredentialId: z.string().max(36).optional(),
    // The saved harnesses and repo ablations picked (RunHarnessesPanel), checked on submit.
    harnesses: pickedIds,
    environments: pickedIds,
    // What drafts picked before the two lists: rows of a saved harness and a repo ablation, each
    // moved into its list. A row written out on this page is dropped whole, rather than keeping
    // its repo ablation and losing the rest.
    conditions: z.array(z.unknown()).max(MAX_CONDITIONS).optional().catch(undefined),
    baseline: z.boolean().optional(),
  }),
});
/** A row as the Run page once picked it; any other key marks a written-out row, which is dropped. */
const pickedConditionRow = z
  .object({
    saved: z.number().int().positive().optional(),
    environment: z.number().int().positive().optional(),
    subagentCredentialId: z.string().max(36).optional(),
  })
  .strict();

/** A draft's picked harnesses and repo ablations, with an older draft's rows moved into them. */
function withPicked<Draft extends z.infer<typeof draftStateSchema>["draft"]>(
  draft: Draft,
): Omit<Draft, "conditions"> {
  const { conditions, ...rest } = draft;
  const rows = (conditions ?? []).flatMap((row) => {
    const parsed = pickedConditionRow.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const merged = (given: number[] | undefined, more: (number | undefined)[]) => {
    const ids = [...new Set([...(given ?? []), ...more.filter((id) => id !== undefined)])].slice(
      0,
      MAX_PICKED,
    );
    return ids.length ? ids : undefined;
  };
  const harnesses = merged(
    draft.harnesses,
    rows.map((row) => row.saved),
  );
  const environments = merged(
    draft.environments,
    rows.map((row) => row.environment),
  );
  const { harnesses: _, environments: __, ...others } = rest;
  return {
    ...others,
    ...(harnesses ? { harnesses } : {}),
    ...(environments ? { environments } : {}),
  } as Omit<Draft, "conditions">;
}
const blankModel = () => ({ catalogId: "", credentialId: "", harnesses: [] });

type DraftState = z.infer<typeof draftStateSchema>;
type RestoredDraft = Omit<DraftState, "draft"> & { draft: Omit<DraftState["draft"], "conditions"> };

/** The Run page's saved draft, or a new one with the tasks a link picked (`?tasks=`). */
export function restoreRunDraft(saved: string | null, selectedTasks: string | null): RestoredDraft {
  if (saved && selectedTasks === null) {
    try {
      const parsed = draftStateSchema.safeParse(JSON.parse(saved));
      if (parsed.success) {
        const draft = withPicked(parsed.data.draft);
        if (!draft.models.length) draft.models = [blankModel()];
        return { ...parsed.data, draft };
      }
    } catch {}
  }
  let tasks: z.infer<typeof tasksSchema> = [];
  if (selectedTasks) {
    try {
      const parsed = tasksSchema.safeParse(JSON.parse(selectedTasks));
      if (parsed.success) tasks = parsed.data;
    } catch {}
  }
  return {
    submitted: false,
    sandboxDefaultPending: true,
    draft: {
      id: evaluationRequestId(),
      tasks,
      models: [blankModel()],
      sandbox: "e2b" as const,
      sandboxCredentialId: "",
      skipCompleted: false,
    },
  };
}
