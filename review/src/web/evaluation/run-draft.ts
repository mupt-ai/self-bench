import { z } from "zod";
import { thinkingLevels } from "../../../../src/contracts/models";
import { harnessIds } from "../../../../src/evaluation/models";
import { evaluationRequestId } from "./api";

const tasksSchema = z.array(
  z.object({ runId: z.string().min(1).max(100), taskId: z.string().min(1).max(200) }),
);
/** What every saved Run draft keeps besides its tasks: models and where they run. */
const selectionFields = {
  id: z.uuid(),
  models: z
    .array(
      z.object({
        catalogId: z.string().max(200),
        credentialId: z.string().max(36),
        thinking: z.enum(thinkingLevels).optional(),
        subagent: z
          .object({ catalogId: z.string().max(200), credentialId: z.string().max(36) })
          .optional(),
        customModel: z.string().max(200).optional(),
        harnesses: z.array(z.enum(harnessIds)).max(harnessIds.length),
      }),
    )
    .max(12),
  sandbox: z.enum(["managed", "e2b", "modal", "daytona"]),
  sandboxCredentialId: z.string().max(36),
  skipCompleted: z.boolean().optional(),
};
const stateFields = { submitted: z.boolean(), sandboxDefaultPending: z.boolean().optional() };
const draftStateSchema = z.object({
  ...stateFields,
  draft: z.object({ ...selectionFields, tasks: tasksSchema }),
});
const benchmarkStateSchema = z.object({
  ...stateFields,
  draft: z.object({ ...selectionFields, judgeCredentialId: z.string().max(36).optional() }),
});
const blankModel = () => ({ catalogId: "", credentialId: "", harnesses: [] });

export function restoreRunDraft(saved: string | null, selectedTasks: string | null) {
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

/** A benchmark's saved Run draft, or a new one: it runs the benchmark's dataset, so no tasks. */
export type BenchmarkRunState = z.infer<typeof benchmarkStateSchema>;

export function restoreBenchmarkDraft(saved: string | null): BenchmarkRunState {
  if (saved) {
    try {
      const parsed = benchmarkStateSchema.safeParse(JSON.parse(saved));
      if (parsed.success) {
        if (!parsed.data.draft.models.length) parsed.data.draft.models = [blankModel()];
        return parsed.data;
      }
    } catch {}
  }
  return {
    submitted: false,
    sandboxDefaultPending: true,
    draft: {
      id: evaluationRequestId(),
      models: [blankModel()],
      sandbox: "e2b" as const,
      sandboxCredentialId: "",
      skipCompleted: false,
    },
  };
}
