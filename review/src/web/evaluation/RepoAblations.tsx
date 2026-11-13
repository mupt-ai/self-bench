import { MAX_PICKED } from "../../../../src/contracts/conditions";
import type { EnvironmentItem } from "../environments/environment-api";
import { InfoTooltip } from "../primitives/tooltip";

/** What the Tasks box picks beside its tasks: the repo ablations to run them in too. */
export interface AblationPick {
  /** The repository's repo ablations; undefined until they load. */
  environments: EnvironmentItem[] | undefined;
  /** The picked repo ablations, by id. */
  picked: number[];
  /** Whether the tasks also run as they are; only asked once a repo ablation is picked. */
  original: boolean;
  onChange: (picked: number[], original: boolean) => void;
}

/** A Run draft's repo ablation picks, and how the Tasks box changes them. */
export function ablationPick<Draft extends { environments?: number[]; baseline?: boolean }>(
  draft: Draft,
  environments: EnvironmentItem[] | undefined,
  change: (update: (draft: Draft) => Draft) => void,
): AblationPick {
  return {
    environments,
    picked: draft.environments ?? [],
    original: draft.baseline !== false,
    onChange: (picked, original) =>
      change((current) => {
        const { environments: _, baseline: __, ...rest } = current;
        return {
          ...rest,
          ...(picked.length ? { environments: picked } : {}),
          ...(original ? {} : { baseline: false }),
        } as Draft;
      }),
  };
}

const chip =
  "flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs has-[:checked]:border-foreground/40 has-[:checked]:bg-muted has-[:disabled]:opacity-60";

/**
 * One line in the Tasks box: the repository's repo ablations, each a checkbox, and whether the
 * original tasks run beside the picked ones. Nothing for a repository with no repo ablations.
 */
export function RepoAblations({
  environments,
  picked,
  original,
  onChange,
  disabled,
}: AblationPick & { disabled: boolean }) {
  // A pick whose repo ablation is gone (deleted since) still shows, so it can be unpicked.
  const gone = environments
    ? picked.filter((id) => !environments.some((entry) => entry.id === id))
    : [];
  const entries = [
    ...(environments ?? []).map(({ id, name }) => ({ id, name })),
    ...gone.map((id) => ({ id, name: `Deleted (${id})` })),
  ];
  if (entries.length === 0) return null;
  return (
    <fieldset
      aria-label="Repo Ablations"
      disabled={disabled}
      className="flex min-w-0 flex-wrap items-center gap-2 border-0 border-t border-border px-4 py-2.5"
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        Repo Ablations
        <InfoTooltip
          label={`Each picked repo ablation runs every row again on the tasks it built, with their files changed. Tasks it has no ready build for are left out. Pick up to ${MAX_PICKED}.`}
        />
      </span>
      {entries.map((entry) => {
        const checked = picked.includes(entry.id);
        return (
          <label key={entry.id} className={chip}>
            <input
              type="checkbox"
              className="size-3.5 accent-brand"
              aria-label={entry.name}
              checked={checked}
              disabled={!checked && picked.length >= MAX_PICKED}
              onChange={() => {
                const next = checked
                  ? picked.filter((id) => id !== entry.id)
                  : [...picked, entry.id];
                // With none picked, the original tasks are all there is to run.
                onChange(next, next.length ? original : true);
              }}
            />
            {entry.name}
          </label>
        );
      })}
      {picked.length > 0 && (
        <label className="ml-auto flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="size-3.5 accent-brand"
            aria-label="Original Tasks"
            checked={original}
            onChange={(event) => onChange(picked, event.target.checked)}
          />
          Original Tasks
          <InfoTooltip label="Also run the tasks as they are. Turn off to run only the picked repo ablations." />
        </label>
      )}
    </fieldset>
  );
}
