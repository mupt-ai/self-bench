import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { listEnvironments } from "../environments/environment-api";
import { listHarnesses } from "../harnesses/harness-api";
import type { HarnessChoices } from "./run-harnesses";

/**
 * What a Run page picks from: the workspace's saved harnesses, for each model row's Harness, and
 * the repository's repo ablations when the page is a repository's (a benchmark or a group has none).
 */
export function useHarnessChoices(
  org: string,
  repo: string | undefined,
  models: CatalogModel[],
  credentials: CredentialInfo[],
): HarnessChoices {
  const [saved, setSaved] = React.useState<HarnessChoices["saved"]>();
  const [environments, setEnvironments] = React.useState<HarnessChoices["environments"]>(
    repo ? undefined : [],
  );
  React.useEffect(() => {
    let stopped = false;
    const keep =
      <Value>(set: (value: Value) => void) =>
      (value: Value) => {
        if (!stopped) set(value);
      };
    // A list that fails to load leaves its picker empty; the server checks what is submitted.
    listHarnesses(org).then(keep(setSaved), () => keep(setSaved)([]));
    if (repo) listEnvironments(org, repo).then(keep(setEnvironments), () => undefined);
    else setEnvironments([]);
    return () => {
      stopped = true;
    };
  }, [org, repo]);
  return { saved, environments, models, credentials };
}
