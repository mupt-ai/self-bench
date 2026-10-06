import { GROUP_SLUG } from "../../../../src/public/paths";
import { plural } from "../api";
import { fieldStyles, Input } from "../ui";
import type { GroupReleaseView } from "./api";
import { repositoriesOf } from "./selection";

/** Whether `slug` can be a group's address on selfbench.dev. */
export const validSlug = (slug: string) => GROUP_SLUG.test(slug);

/**
 * What a group's release adds to the dialog: the address its page takes, chosen on the first
 * release and kept after, and how many of the released tasks each repository contributes.
 */
export function GroupReleaseFields({
  view,
  tasks,
  slug,
  onSlug,
  disabled,
}: {
  view: GroupReleaseView;
  /** The selection's tasks, as indexes into the preview's. */
  tasks: readonly number[];
  slug: string;
  onSlug(slug: string): void;
  disabled: boolean;
}) {
  const repositories = repositoriesOf(view.preview, tasks);
  return (
    <div className="grid gap-3 border border-border p-3 text-sm">
      {view.slug === null ? (
        <label className={fieldStyles} htmlFor="release-group-slug">
          Public Address
          <span className="flex min-w-0 items-center gap-1 font-mono text-xs font-normal">
            <span className="shrink-0 text-muted-foreground">selfbench.dev/groups/</span>
            <Input
              id="release-group-slug"
              value={slug}
              disabled={disabled}
              maxLength={64}
              aria-invalid={!validSlug(slug)}
              onChange={(event) => onSlug(event.target.value.toLowerCase())}
            />
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            Lowercase letters, digits, and hyphens. The address is kept for every later release.
          </span>
        </label>
      ) : (
        <p>
          <span className="font-medium">Public Address</span>{" "}
          <span className="font-mono text-xs">selfbench.dev/groups/{view.slug}</span>
        </p>
      )}
      <ul className="grid gap-1">
        {repositories.map((repository) => (
          <li key={repository.fullName} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-xs">{repository.fullName}</span>
            <span
              className={`shrink-0 text-xs ${repository.tasks === 0 ? "text-warning" : "text-muted-foreground"}`}
            >
              {repository.tasks === 0
                ? "Left out: no task every ticked setting ran"
                : plural(repository.tasks, "task")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
