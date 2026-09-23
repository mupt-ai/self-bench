import type { PublicRepoPage } from "./contract";
import { memorySource, type PublicSource } from "./source";

/**
 * Development data. Reads every JSON file under `fixtures/local/`, one repository page per
 * file. That directory is excluded from git; with no files the site shows its empty states.
 */
export function fixtureSource(): PublicSource {
  const files = import.meta.glob<PublicRepoPage>("./fixtures/local/*.json", {
    eager: true,
    import: "default",
  });
  return memorySource(Object.values(files));
}
