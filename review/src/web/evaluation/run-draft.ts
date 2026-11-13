import { z } from "zod";
import { MAX_PICKED } from "../../../../src/contracts/conditions";
import { thinkingLevels } from "../../../../src/contracts/models";
import { harnessIds } from "../../../../src/evaluation/models";
import { evaluationRequestId } from "./api";

const tasksSchema = z.array(
  z.object({ runId: z.string().min(1).max(100), taskId: z.string().min(1).max(200) }),
);
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
          // The saved harness the row runs in place of its harness as it is.
          harness: z.number().int().positive().optional().catch(undefined),
        }),
      )
      .max(12),
    sandbox: z.enum(["managed", "e2b", "modal", "daytona"]),
    sandboxCredentialId: z.string().max(36),
    skipCompleted: z.boolean().optional(),
    judgeCredentialId: z.string().max(36).optional(),
    // The repo ablations the tasks also run in, and whether they run as they are too. What older
    // drafts picked for every row at once (`harnesses`, `conditions`) is dropped: a saved harness
    // is now each row's own.
    environments: z.array(z.number().int().positive()).max(MAX_PICKED).optional().catch(undefined),
    baseline: z.boolean().optional(),
  }),
});
/**
 * The draft without the keys it left unset, and with the tasks as they are run again once no repo
 * ablation is picked: there would be nothing else to run.
 */
function withoutUnset(draft: z.infer<typeof draftStateSchema>["draft"]) {
  const { environments, baseline, models, ...rest } = draft;
  return {
    ...rest,
    models: models.map(({ harness, ...model }) => ({
      ...model,
      ...(harness !== undefined ? { harness } : {}),
    })),
    ...(environments?.length ? { environments } : {}),
    ...(baseline === false && environments?.length ? { baseline } : {}),
  };
}
const blankModel = () => ({ catalogId: "", credentialId: "", harnesses: [] });

type RestoredDraft = z.infer<typeof draftStateSchema>;

/** The Run page's saved draft, or a new one with the tasks a link picked (`?tasks=`). */
export function restoreRunDraft(saved: string | null, selectedTasks: string | null): RestoredDraft {
  if (saved && selectedTasks === null) {
    try {
      const parsed = draftStateSchema.safeParse(JSON.parse(saved));
      if (parsed.success) {
        const draft = withoutUnset(parsed.data.draft);
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
