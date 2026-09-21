import { fetchOrgMemberships, type OrgMembership } from "./github.js";

/** How long a membership answer stays trusted before GitHub is asked again. */
const ALLOWED_ORGS_TTL_MS = 5 * 60 * 1000;

/** The session cannot outlive the allowlist: a removed member is denied, not just signed out. */
export class OrgAccessError extends Error {
  constructor() {
    super("Access is limited to members of approved GitHub organizations.");
  }
}

export interface OrgGate {
  /** True when sign-in may proceed: open when no allowlist is configured. */
  admits(orgs: readonly OrgMembership[]): boolean;
  /** Membership for an existing session, cached briefly so removals do not wait for expiry. */
  permits(githubId: number, token: string): Promise<boolean>;
}

export function createOrgGate(options: {
  githubApiUrl: string;
  allowedOrgs: readonly string[];
  fetchImpl: typeof fetch;
  now?: () => Date;
}): OrgGate {
  const { allowedOrgs } = options;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl;
  const cache = new Map<number, { at: number; allowed: boolean }>();
  const isMember = (orgs: readonly OrgMembership[]): boolean =>
    orgs.some((org) => allowedOrgs.includes(org.login.toLowerCase()));
  return {
    admits: (orgs) => allowedOrgs.length === 0 || isMember(orgs),
    async permits(githubId, token) {
      if (allowedOrgs.length === 0) return true;
      const cached = cache.get(githubId);
      if (cached && now().getTime() - cached.at < ALLOWED_ORGS_TTL_MS) return cached.allowed;
      const orgs = await fetchOrgMemberships({ githubApiUrl: options.githubApiUrl }, token, fetchImpl);
      const allowed = isMember(orgs);
      cache.set(githubId, { at: now().getTime(), allowed });
      return allowed;
    },
  };
}
