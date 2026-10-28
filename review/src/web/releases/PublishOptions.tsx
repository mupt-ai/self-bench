import { formatAgo } from "../api";
import { Tick } from "./SettingsPicker";

/** What a release publishes beyond each setting's scores. */
export interface Publish {
  tasks: boolean;
  /** Each setting's result and transcript on each task; published only with the tasks. */
  trials: boolean;
  /** The latest Model Summaries report's sections on the released settings. */
  summaries: boolean;
}

/**
 * A release publishes its tasks unless the releaser unticks them. Its trials, with every
 * transcript, and its model summaries are published only when the releaser ticks them too.
 */
export const PUBLISH_DEFAULTS: Publish = { tasks: true, trials: false, summaries: false };

/** What becomes public and what stays private, shown on the info icon beside the summary. */
export function privacyNote(
  workspace: { login: string; kind: "org" | "user" },
  publish: Publish,
): string {
  const note = scopeNote(workspace, publish);
  return publish.summaries
    ? `${note} Also public: a model's summary of each covered setting's strengths and failures.`
    : note;
}

function scopeNote(workspace: { login: string; kind: "org" | "user" }, publish: Publish): string {
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
 * The release's Publish Tasks, Publish Results by Task and Publish Model Summaries boxes, each
 * tinted while on so what a release makes public is plain to see. The results name the tasks, so
 * the second box needs the first. The third shows only when there is a report, and is off while
 * it covers none of the ticked settings.
 */
export function PublishOptions({
  publish,
  disabled,
  summaries,
  onChange,
}: {
  publish: Publish;
  disabled: boolean;
  /** The latest report: how many of the ticked settings it covers, and when it was written. */
  summaries?: { covered: number; ticked: number; summarizedAt: string };
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
      {summaries && (
        <Option
          id="release-publish-summaries"
          label="Publish Model Summaries"
          checked={publish.summaries && summaries.covered > 0}
          disabled={disabled || summaries.covered === 0}
          onChange={(next) => onChange({ ...publish, summaries: next })}
        >
          Anyone can read the latest Model Summaries, written {formatAgo(summaries.summarizedAt)},
          on the {summaries.covered} of {summaries.ticked} ticked settings it covers.
          {summaries.covered < summaries.ticked &&
            " Summarize again on the Results page to cover the rest."}
        </Option>
      )}
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
