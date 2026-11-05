/**
 * A task or dataset in Harbor's package registry, `org/name@ref` (a tag, a revision, or a
 * `sha256:` digest; `latest` when left out). Names start with a letter or digit, so a reference
 * is never read as a flag.
 */
export const REGISTRY_REFERENCE =
  /^([A-Za-z0-9][A-Za-z0-9._-]{0,98})\/([A-Za-z0-9][A-Za-z0-9._-]{0,98})(?:@([A-Za-z0-9][A-Za-z0-9._:-]{0,99}))?$/;

/** Enough for the largest registry datasets, such as SWE-bench Verified's 500 tasks. */
export const MAX_REGISTRY_TASKS = 500;

/** A public dataset in Harbor's registry, as the add box searches them. */
export interface RegistryDataset {
  /** `org/name` */
  name: string;
  description?: string;
  /** Tasks in its latest version. */
  tasks: number;
}

/** The reference with its ref spelled out. */
export function registryReference(value: string): string {
  const match = REGISTRY_REFERENCE.exec(value);
  if (!match) throw new Error("Harbor registry references take the form org/name@ref");
  return `${match[1]}/${match[2]}@${match[3] ?? "latest"}`;
}
