import type { TaskEnvironment } from "./contracts.js";

const secretName = /(?:TOKEN|SECRET|PRIVATE_KEY|ACCESS_KEY|API_KEY|CREDENTIAL)/i;
const passwordName = /PASSWORD/i;
const pinnedImage =
  /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?(?:[a-z0-9._-]+\/)*[a-z0-9._-]+(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;

export function assertEnvironmentPolicy(environment: TaskEnvironment): void {
  assertPinnedImage(environment.baseImage, "environment baseImage");
  rejectSecretMaterial(environment.rootSetupCommand, "rootSetupCommand");
  rejectSecretMaterial(environment.setupCommand, "setupCommand");
  rejectSecretMaterial(environment.smokeCommand, "smokeCommand");
  if (
    /\bdocker(?:d|\s|-)\b/i.test(`${environment.rootSetupCommand}\n${environment.setupCommand}`)
  ) {
    throw new Error("environment setup must not invoke Docker-in-Docker");
  }
  const serviceNames = new Set<string>();
  for (const service of environment.services) {
    assertPinnedImage(service.image, `service ${service.name} image`);
    if (serviceNames.has(service.name)) {
      throw new Error(`environment repeats service ${service.name}`);
    }
    serviceNames.add(service.name);
    rejectSecrets(service.environmentVariables, `service ${service.name}`, true);
    rejectSecretMaterial((service.command ?? []).join("\n"), `service ${service.name} command`);
    rejectSecretMaterial(
      service.healthcheck.test.join("\n"),
      `service ${service.name} healthcheck`,
    );
  }
  rejectSecrets(environment.environmentVariables, "environment", false);
  for (const evidence of environment.evidence) {
    if (evidence.path.startsWith(".git/")) {
      throw new Error(`environment evidence cannot reference Git internals: ${evidence.path}`);
    }
  }
}

function assertPinnedImage(image: string, scope: string): void {
  if (!pinnedImage.test(image)) {
    throw new Error(`${scope} must be a valid OCI reference pinned by sha256 digest`);
  }
}

function rejectSecrets(
  variables: Readonly<Record<string, string>>,
  scope: string,
  allowPassword: boolean,
): void {
  for (const [name, value] of Object.entries(variables)) {
    if (/[\0\r\n]/.test(value)) {
      throw new Error(`${scope} variable ${name} contains a control character`);
    }
    if (/\$\{|\$[A-Za-z_]/.test(value)) {
      throw new Error(`${scope} variable ${name} must not interpolate host environment values`);
    }
    if (
      (secretName.test(name) || (!allowPassword && passwordName.test(name))) &&
      !isPlaceholderSecretValue(value)
    ) {
      throw new Error(
        `${scope} variable ${name} looks like a secret; only a fixed placeholder literal is allowed`,
      );
    }
  }
}

const knownKeyPrefix =
  /^(?:sk[-_]|rk[-_]|pk[-_]live|gh[pousr]_|github_pat_|AKIA|ASIA|xox[abpsr]-|AIza|ya29\.|glpat-|npm_|dop_v1_|eyJ[A-Za-z0-9_-]{8,}\.)/;
const placeholderWord =
  /(?:^|[^a-z])(?:test(?:ing)?|dummy|fake|placeholder|example|sample|local|dev(?:elopment)?|insecure|changeme|change-me|not-?a-?(?:real-?)?(?:key|secret|token)|selfbench|ci)(?:$|[^a-z])/i;
const PLACEHOLDER_MAX_LENGTH = 16;
const SECRET_RUN_MIN_LENGTH = 16;
const SECRET_RUN_ENTROPY_BITS = 3.5;

/**
 * A secret-named variable may carry a fixed placeholder literal: no entropy, short, or a documented
 * placeholder pattern. Values shaped like real key material stay rejected.
 */
export function isPlaceholderSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (knownKeyPrefix.test(trimmed) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(trimmed)) {
    return false;
  }
  const runs = trimmed.split(/[^A-Za-z0-9+/=]+/).filter(Boolean);
  const highEntropyRun = runs.some(
    (run) => run.length >= SECRET_RUN_MIN_LENGTH && shannonEntropy(run) >= SECRET_RUN_ENTROPY_BITS,
  );
  if (highEntropyRun) {
    return false;
  }
  if (placeholderWord.test(trimmed) || /^(.)\1*$/.test(trimmed)) {
    return true;
  }
  return trimmed.length <= PLACEHOLDER_MAX_LENGTH;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function rejectSecretMaterial(value: string, scope: string): void {
  if (
    /\$\{\{\s*secrets\.|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:GH|GITHUB|NPM|PYPI|AWS|OPENAI|E2B|VERCEL|MODAL)_(?:TOKEN|KEY|SECRET)/i.test(
      value,
    )
  ) {
    throw new Error(`${scope} references secret material`);
  }
}

export function assertEnvironmentEvidence(
  environment: TaskEnvironment,
  repositoryPaths: ReadonlySet<string>,
): void {
  const missing = environment.evidence
    .map(({ path }) => path)
    .filter((path) => !repositoryPaths.has(path));
  if (missing.length > 0) {
    throw new Error(
      `environment evidence does not exist at the pinned commit: ${missing.join(", ")}`,
    );
  }
}
