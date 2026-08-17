const VERCEL_CONTROL_CREDENTIALS = [
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_OIDC_TOKEN",
] as const;

export function harborChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const child = { ...environment };
  for (const key of VERCEL_CONTROL_CREDENTIALS) {
    delete child[key];
  }
  return child;
}
