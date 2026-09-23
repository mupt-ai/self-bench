import {
  fetchOrgMemberships,
  GitHubIdentityError,
  GitHubOAuthError,
  type OrgMembership,
} from "../../third_party/github/oauth.js";

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
  admits(githubId: number, orgs: readonly OrgMembership[]): boolean;
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
  const remember = (githubId: number, orgs: readonly OrgMembership[]): boolean => {
    const allowed = allowedOrgs.length === 0 || isMember(orgs);
    cache.set(githubId, { at: now().getTime(), allowed });
    return allowed;
  };
  return {
    admits: remember,
    async permits(githubId, token) {
      if (allowedOrgs.length === 0) return true;
      const cached = cache.get(githubId);
      if (cached && now().getTime() - cached.at < ALLOWED_ORGS_TTL_MS) return cached.allowed;
      try {
        const orgs = await fetchOrgMemberships(
          { githubApiUrl: options.githubApiUrl },
          token,
          fetchImpl,
        );
        return remember(githubId, orgs);
      } catch (error) {
        const status = error instanceof GitHubOAuthError ? error.status : undefined;
        throw new GitHubIdentityError(
          status === 401 || status === 403 || status === 429 ? status : 503,
        );
      }
    },
  };
}
