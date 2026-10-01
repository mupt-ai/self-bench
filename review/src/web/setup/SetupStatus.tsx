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
}

export const SetupStatusContext = React.createContext<SetupStatus>({
  canManage: false,
  incomplete: false,
  refresh: async () => undefined,
});

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
  return React.useMemo<SetupStatus>(() => {
    const coverage = data && setupCoverage(data.credentials);
    return {
      credentials: data?.credentials,
      canManage: data?.canManage ?? false,
      error,
      incomplete:
        !managedOffering &&
        !!coverage &&
        !(covered(coverage.generate) && covered(coverage.evaluate)),
      refresh: load,
    };
  }, [data, error, managedOffering, load]);
}
