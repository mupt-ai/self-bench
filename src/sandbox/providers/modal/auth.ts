const MODAL_CREDENTIAL_KEYS = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"] as const;

export function removeEmptyModalCredentialOverrides(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  for (const key of MODAL_CREDENTIAL_KEYS) {
    if (environment[key]?.trim() === "") {
      delete environment[key];
    }
  }
}
