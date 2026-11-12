import { z } from "zod";
import { MAX_SKILL_LENGTH, MAX_SKILLS } from "../../../../src/contracts/conditions";
import { MAX_NATIVE_CONFIG } from "../../../../src/contracts/harness-options";
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
    // Run conditions as typed: checked on submit (RunConditionsPanel), so a draft may be partial.
    conditions: z
      .array(
        z.object({
          name: z.string().max(60),
          skills: z.array(z.string().max(MAX_SKILL_LENGTH)).max(MAX_SKILLS),
          instructions: z.string().max(4000).optional(),
          environment: z.number().int().positive().optional(),
          // Harness options by harness and option name: typed text while editing
          // (RunHarnessOptions), their values once submitted (submittedConditions).
          harnessOptions: z
            .partialRecord(
              z.enum(harnessIds),
              z.record(
                z.string().max(100),
                z.union([
                  z.string().max(MAX_NATIVE_CONFIG),
                  z.number(),
                  z.boolean(),
                  z.record(z.string(), z.unknown()),
                ]),
              ),
            )
            .optional(),
        }),
      )
      .max(4)
      .optional(),
    baseline: z.boolean().optional(),
  }),
});
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
