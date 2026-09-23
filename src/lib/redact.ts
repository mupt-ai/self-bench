export function redactSecrets(value: string): string {
  const replacements: readonly [RegExp, string][] = [
    [
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    ],
    [/Authorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization: Bearer [REDACTED]"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "AWS_ACCESS_KEY_ID=[REDACTED]"],
    [/AWS_SECRET_ACCESS_KEY\s*[:=]\s*[^\s,;]+/gi, "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
    [/\bnpm_[A-Za-z0-9]{16,}\b/g, "npm_[REDACTED]"],
    [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, "glpat-[REDACTED]"],
    [/\b(?:password|passwd|pwd)\s*[:=]\s*[^\s,;]+/gi, "password=[REDACTED]"],
    [/\b(?:database_url|db_url)\s*[:=]\s*[^\s]+/gi, "DATABASE_URL=[REDACTED]"],
    [
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s]+/gi,
      "[REDACTED DATABASE URL]",
    ],
    [/\bdari_[A-Za-z0-9_-]{16,}/g, "dari_[REDACTED]"],
    [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
    [/\b(?:ghp|github_pat)_[A-Za-z0-9_-]{16,}/g, "github_[REDACTED]"],
    [
      /\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET)\s*[:=]\s*[^\s,;]+/g,
      "SECRET=[REDACTED]",
    ],
  ];
  return replacements.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    value,
  );
}
