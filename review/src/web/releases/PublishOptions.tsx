import { Tick } from "./SettingsPicker";

/** What a release publishes beyond each setting's scores. */
export interface Publish {
  tasks: boolean;
  /** Each setting's result and transcript on each task; published only with the tasks. */
  trials: boolean;
}

/**
 * A release publishes its tasks unless the releaser unticks them. Its trials, with every
 * transcript, are published only when the releaser ticks that too.
 */
export const PUBLISH_DEFAULTS: Publish = { tasks: true, trials: false };

/** What becomes public and what stays private, shown on the info icon beside the summary. */
export function privacyNote(
  workspace: { login: string; kind: "org" | "user" },
  publish: Publish,
): string {
  const publisher =
    workspace.kind === "user"
      ? `you as publisher, under your GitHub username ${workspace.login}`
      : `the ${workspace.login} workspace as publisher`;
  if (publish.tasks && publish.trials)
    return `Public: the repository, ${publisher}, each setting's model, harness, accuracy, and cost, each task with its pull request, instruction, tests, and solution, and each setting's result, grading, test output, and transcript on each task, with secrets redacted. Private: the rest of Harbor's logs, artifacts, endpoint hosts, and who pressed Release.`;
  return publish.tasks
    ? `Public: the repository, ${publisher}, each setting's model, harness, accuracy, and cost, and each task with its pull request, instruction, tests, and solution. Private: per-task results, transcripts, endpoint hosts, and who pressed Release.`
    : `Public: the repository, ${publisher}, and each setting's model, harness, accuracy, and cost. Private: which tasks and pull requests were used, per-task results, transcripts, endpoint hosts, and who pressed Release.`;
}

/**
 * The release's Publish Tasks and Publish Results by Task boxes, each tinted while on so what a
 * release makes public is plain to see. The results name the tasks, so the second box needs the
 * first.
 */
export function PublishOptions({
  publish,
  disabled,
  onChange,
}: {
  publish: Publish;
  disabled: boolean;
  onChange(publish: Publish): void;
}) {
  return (
    <div className="space-y-2">
      <Option
        id="release-publish-tasks"
        label="Publish Tasks"
        checked={publish.tasks}
        disabled={disabled}
        onChange={(tasks) => onChange({ ...publish, tasks })}
      >
        Anyone can browse and download each task's instruction, tests, and solution on
        selfbench.dev.
      </Option>
      <Option
        id="release-publish-trials"
        label="Publish Results by Task"
        checked={publish.tasks && publish.trials}
        disabled={disabled || !publish.tasks}
        onChange={(trials) => onChange({ ...publish, trials })}
      >
        Anyone can see whether each setting passed each task, how it was graded, and its test output
        and transcript, with secrets redacted. The rest of Harbor's logs and artifacts stay private.
      </Option>
    </div>
  );
}

function Option({
  id,
  label,
  checked,
  disabled,
  onChange,
  children,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange(checked: boolean): void;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-2.5 border p-3 text-sm transition-colors ${
        checked ? "border-check/50 bg-check/[0.07]" : "border-border"
      }`}
    >
      <span className="mt-0.5 flex">
        <Tick id={id} checked={checked} disabled={disabled} onChange={onChange} />
      </span>
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="block text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}
