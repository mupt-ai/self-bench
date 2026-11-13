import { z } from "zod";
import { MAX_CONDITIONS } from "../../../../src/contracts/conditions";
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
        }),
      )
      .max(12),
    sandbox: z.enum(["managed", "e2b", "modal", "daytona"]),
    sandboxCredentialId: z.string().max(36),
    skipCompleted: z.boolean().optional(),
    judgeCredentialId: z.string().max(36).optional(),
    // The saved conditions and environments picked (RunConditionsPanel), checked on submit. A
    // draft from when conditions were written out on this page drops each written-out row whole,
    // rather than keeping its environment and losing the rest.
    conditions: z
      .array(z.unknown())
      .max(MAX_CONDITIONS)
      .transform((rows) =>
        rows.flatMap((row) => {
          const parsed = pickedConditionRow.safeParse(row);
          if (!parsed.success) return [];
          const { saved, environment } = parsed.data;
          return saved !== undefined || environment !== undefined ? [parsed.data] : [];
        }),
      )
      .optional()
      .catch(undefined),
    baseline: z.boolean().optional(),
  }),
});
/** A row as RunConditionsPanel picks it; any other key marks a written-out condition, which is dropped. */
const pickedConditionRow = z
  .object({
    saved: z.number().int().positive().optional(),
    environment: z.number().int().positive().optional(),
    subagentCredentialId: z.string().max(36).optional(),
  })
  .strict();
const blankModel = () => ({ catalogId: "", credentialId: "", harnesses: [] });

/** The Run page's saved draft, or a new one with the tasks a link picked (`?tasks=`). */
export function restoreRunDraft(
  saved: string | null,
  selectedTasks: string | null,
): z.infer<typeof draftStateSchema> {
  if (saved && selectedTasks === null) {
    try {
      const parsed = draftStateSchema.safeParse(JSON.parse(saved));
      if (parsed.success) {
        if (!parsed.data.draft.models.length) parsed.data.draft.models = [blankModel()];
        return parsed.data;
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
