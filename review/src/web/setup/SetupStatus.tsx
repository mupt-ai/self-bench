import React from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { evaluationRequest } from "../evaluation/api";
import { covered, setupCoverage } from "./readiness";

interface SetupStatus {
  /** The organization's credentials, once loaded. */
  credentials?: CredentialInfo[];
  canManage: boolean;
  error?: string;
  /** Loaded, and the organization cannot yet both generate and evaluate on its own credentials. */
  incomplete: boolean;
  refresh(): Promise<void>;
  /** The setup popup: opened on an admin's first visit to an org that is not set up, or on request. */
  dialogOpen: boolean;
  openDialog(): void;
  closeDialog(): void;
}

export const SetupStatusContext = React.createContext<SetupStatus>({
  canManage: false,
  incomplete: false,
  refresh: async () => undefined,
  dialogOpen: false,
  openDialog: () => undefined,
  closeDialog: () => undefined,
});

const seenKey = (org: string) => `selfbench.setup.seen:${org}`;

export function useSetupStatus(): SetupStatus {
  return React.useContext(SetupStatusContext);
}

/**
 * One credential list per organization for the first-run prompts: the sidebar's Get Started
 * entry, the repositories banner, and the setup page itself. The layout loads it and provides
 * it through `SetupStatusContext`; pages that change credentials call `refresh` so the prompts
 * clear as soon as setup is done. A deployment with the managed offering never prompts, since
 * its forms offer managed models and sandboxes.
 */
export function useSetupStatusSource(org: string, managedOffering: boolean): SetupStatus {
  const url = `/api/orgs/${encodeURIComponent(org)}/credentials`;
  // Each result remembers its org's URL, so a switch never shows the previous org's state.
  const [loaded, setLoaded] = React.useState<{
    url: string;
    data?: { credentials: CredentialInfo[]; canManage: boolean };
    error?: string;
  }>();
  const latest = React.useRef(0);
  const load = React.useCallback(async () => {
    const request = ++latest.current;
    try {
      const data = await evaluationRequest<{ credentials: CredentialInfo[]; canManage: boolean }>(
        url,
      );
      if (request === latest.current) setLoaded({ url, data });
    } catch (cause) {
      if (request !== latest.current) return;
      const error = cause instanceof Error ? cause.message : "Could not load credentials.";
      setLoaded((current) => ({
        url,
        data: current?.url === url ? current.data : undefined,
        error,
      }));
    }
  }, [url]);
  React.useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);
  const current = loaded?.url === url ? loaded : undefined;
  const data = current?.data;
  const error = current?.error;
  const coverage = data && setupCoverage(data.credentials);
  const incomplete =
    !managedOffering && !!coverage && !(covered(coverage.generate) && covered(coverage.evaluate));
  const [dialogOrg, setDialogOrg] = React.useState<string>();
  // The popup opens by itself once per org in this browser, for someone who can finish setup.
  React.useEffect(() => {
    if (!incomplete || !data?.canManage) return;
    try {
      if (window.localStorage.getItem(seenKey(org))) return;
      window.localStorage.setItem(seenKey(org), "true");
    } catch {
      // Without storage the popup still opens; it may open again on the next visit.
    }
    setDialogOrg(org);
  }, [incomplete, data?.canManage, org]);
  return React.useMemo<SetupStatus>(
    () => ({
      credentials: data?.credentials,
      canManage: data?.canManage ?? false,
      error,
      incomplete,
      refresh: load,
      dialogOpen: dialogOrg === org,
      openDialog: () => {
        if (error) void load();
        setDialogOrg(org);
      },
      closeDialog: () => setDialogOrg(undefined),
    }),
    [data, error, incomplete, load, dialogOrg, org],
  );
}

/**
 * The org's credential list for a form that offers them, fetched on its own and again whenever
 * the shared setup status changes, so finishing setup in the popup unblocks the form.
 */
export function useOrgCredentials(org: string): [CredentialInfo[] | undefined, string] {
  const changed = useSetupStatus().credentials;
  const [credentials, setCredentials] = React.useState<CredentialInfo[]>();
  const [error, setError] = React.useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new shared list means a refetch.
  React.useEffect(() => {
    let disposed = false;
    evaluationRequest<{ credentials: CredentialInfo[] }>(
      `/api/orgs/${encodeURIComponent(org)}/credentials`,
    ).then(
      (result) => {
        if (disposed) return;
        setCredentials(result.credentials);
        setError("");
      },
      (cause: Error) => {
        if (!disposed) setError(cause.message);
      },
    );
    return () => {
      disposed = true;
    };
  }, [org, changed]);
  return [credentials, error];
}
