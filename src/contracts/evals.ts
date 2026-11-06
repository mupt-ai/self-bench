/**
 * An eval is an org's own collection of workspace scenarios, with no GitHub repository behind it.
 * It is stored as a repository row of kind "eval" named `evals/<slug>`, so its dataset, runs, and
 * results use the repository routes; `evals` is reserved as a repository owner.
 */
export const EVAL_OWNER = "evals";

export const MAX_EVAL_NAME_LENGTH = 80;

/** Whether `fullName` names an eval rather than a GitHub repository. */
export function isEvalName(fullName: string): boolean {
  return fullName.toLowerCase().startsWith(`${EVAL_OWNER}/`);
}

/** The slug an eval's name gives it: lowercase words joined by hyphens. */
export function evalSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}
