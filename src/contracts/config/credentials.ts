import { fail } from "../../lib/util.js";
import { normalizeE2BDomain } from "../../sandbox/providers/e2b/template.js";

export interface VercelCredentials {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
}

export interface E2BCredentials {
  readonly apiKey: string;
  readonly domain?: string;
}

export function vercelCredentials(environment: NodeJS.ProcessEnv): VercelCredentials {
  const token = environment.VERCEL_TOKEN?.trim();
  const teamId = environment.VERCEL_TEAM_ID?.trim();
  const projectId = environment.VERCEL_PROJECT_ID?.trim();
  if (!token || !teamId || !projectId) {
    fail("VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID are required for Vercel execution");
  }
  return { token, teamId, projectId };
}

export function e2bCredentials(environment: NodeJS.ProcessEnv): E2BCredentials {
  const apiKey = environment.E2B_API_KEY?.trim();
  if (!apiKey) {
    fail("E2B_API_KEY is required for E2B execution");
  }
  const domain = normalizeE2BDomain(environment.E2B_DOMAIN);
  return { apiKey, ...(domain ? { domain } : {}) };
}
