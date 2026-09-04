import { z } from "zod";

const emptyStringAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const environmentSchema = z.object({
  GITHUB_OAUTH_CLIENT_ID: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  GITHUB_OAUTH_CLIENT_SECRET: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  SELFBENCH_SESSION_SECRET: z.preprocess(emptyStringAsUndefined, z.string().optional()),
  SELFBENCH_PUBLIC_URL: z.preprocess(emptyStringAsUndefined, z.string().url().optional()),
  SELFBENCH_DATABASE_URL: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  GITHUB_URL: z.string().url().default("https://github.com"),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
});

export interface AuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** At least 32 characters; derives the cookie-signing and token-sealing keys. */
  readonly sessionSecret: string;
  /** Public origin of the site (no trailing slash); drives the callback URL and Secure cookies. */
  readonly publicUrl: string;
  readonly databaseUrl: string;
  readonly githubUrl: string;
  readonly githubApiUrl: string;
}

/**
 * GitHub sign-in is opt-in: without GITHUB_OAUTH_CLIENT_ID the API keeps its bearer-token
 * behavior and serves the Ledger as before. Setting it requires the rest to be complete.
 */
export function loadAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AuthConfig | undefined {
  const value = environmentSchema.parse(environment);
  if (!value.GITHUB_OAUTH_CLIENT_ID) return undefined;
  const sessionSecret = value.SELFBENCH_SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) {
    throw new Error("SELFBENCH_SESSION_SECRET must be at least 32 characters for GitHub sign-in");
  }
  return {
    clientId: value.GITHUB_OAUTH_CLIENT_ID,
    clientSecret:
      value.GITHUB_OAUTH_CLIENT_SECRET ??
      fail("GITHUB_OAUTH_CLIENT_SECRET is required for GitHub sign-in"),
    sessionSecret,
    publicUrl: (
      value.SELFBENCH_PUBLIC_URL ?? fail("SELFBENCH_PUBLIC_URL is required for GitHub sign-in")
    ).replace(/\/+$/, ""),
    databaseUrl:
      value.SELFBENCH_DATABASE_URL ?? fail("SELFBENCH_DATABASE_URL is required for GitHub sign-in"),
    githubUrl: value.GITHUB_URL.replace(/\/+$/, ""),
    githubApiUrl: value.GITHUB_API_URL.replace(/\/+$/, ""),
  };
}

function fail(message: string): never {
  throw new Error(message);
}
