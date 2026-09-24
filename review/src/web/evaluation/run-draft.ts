import { z } from "zod";
import { thinkingLevels } from "../../../../src/contracts/models";
import { harnessIds } from "../../../../src/evaluation/models";
import { evaluationRequestId } from "./api";

const tasksSchema = z.array(
  z.object({ runId: z.string().min(1).max(100), taskId: z.string().min(1).max(200) }),
);
const draftStateSchema = z.object({
  submitted: z.boolean(),
  draft: z.object({
    id: z.uuid(),
    tasks: tasksSchema,
    models: z
      .array(
        z.object({
          catalogId: z.string().max(80),
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
  }),
});

export function preferManagedSandbox<
  T extends { submitted: boolean; draft: { sandbox: string; sandboxCredentialId: string } },
>(current: T): T {
  if (current.submitted || current.draft.sandbox !== "e2b" || current.draft.sandboxCredentialId)
    return current;
  return {
    ...current,
    draft: { ...current.draft, sandbox: "managed", sandboxCredentialId: "managed-sandbox" },
  };
}

export function restoreRunDraft(saved: string | null, selectedTasks: string | null) {
  if (saved && selectedTasks === null) {
    try {
      const parsed = draftStateSchema.safeParse(JSON.parse(saved));
      if (parsed.success) {
        if (!parsed.data.draft.models.length) {
          parsed.data.draft.models = [{ catalogId: "", credentialId: "", harnesses: [] }];
        }
        if (
          parsed.data.draft.sandbox === "e2b" &&
          parsed.data.draft.sandboxCredentialId === "managed-sandbox" &&
          !parsed.data.submitted
        ) {
          parsed.data.draft.sandbox = "managed";
        }
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
    draft: {
      id: evaluationRequestId(),
      tasks,
      models: [{ catalogId: "", credentialId: "", harnesses: [] }],
      sandbox: "e2b" as const,
      sandboxCredentialId: "",
      skipCompleted: false,
    },
  };
}
