import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./process.js";

export type ContractArtifactCategory =
  | "endpoint_path"
  | "field_name"
  | "header_name"
  | "media_type";

export interface ContractArtifactEvidence {
  readonly artifact: string;
  readonly category: ContractArtifactCategory;
  readonly testLocations: readonly string[];
  readonly introducedByGold: boolean;
  readonly presentInPrompt: boolean;
  readonly presentInBase: boolean;
}

export interface CouplingEvidence {
  readonly schemaVersion: 1;
  readonly artifacts: readonly ContractArtifactEvidence[];
  readonly blockers: readonly string[];
}

export interface CouplingReviewInput {
  readonly verdict: "clean" | "coupled";
  readonly reason: string;
  readonly findings: readonly {
    readonly artifact: string;
    readonly disposition:
      | "base_contract"
      | "prompt_contract"
      | "external_contract"
      | "gold_only"
      | "not_contract";
  }[];
}

export interface CouplingReviewResolution {
  readonly verdict: "clean" | "coupled";
  readonly reason: string;
  readonly missingArtifacts: readonly string[];
  readonly goldOnlyArtifacts: readonly string[];
}

interface AddedLine {
  readonly location: string;
  readonly text: string;
}

export interface ContractArtifactCandidate {
  readonly artifact: string;
  readonly category: ContractArtifactCategory;
  readonly testLocations: readonly string[];
}

export function discoverContractArtifacts(testPatch: string): readonly ContractArtifactCandidate[] {
  const found = new Map<string, { category: ContractArtifactCategory; locations: Set<string> }>();
  for (const line of addedLines(testPatch)) {
    for (const candidate of contractArtifacts(line.text)) {
      const key = `${candidate.category}\u0000${candidate.artifact}`;
      const existing = found.get(key);
      if (existing) {
        existing.locations.add(line.location);
      } else {
        found.set(key, {
          category: candidate.category,
          locations: new Set([line.location]),
        });
      }
    }
  }
  return [...found.entries()]
    .map(([key, value]) => ({
      artifact: key.slice(key.indexOf("\u0000") + 1),
      category: value.category,
      testLocations: [...value.locations].sort(),
    }))
    .sort((left, right) =>
      left.category === right.category
        ? left.artifact.localeCompare(right.artifact)
        : left.category.localeCompare(right.category),
    );
}

export function buildCouplingEvidence(input: {
  readonly prompt: string;
  readonly testPatch: string;
  readonly goldPatch: string;
  readonly baseArtifacts: ReadonlySet<string>;
}): CouplingEvidence {
  const gold = addedLines(input.goldPatch)
    .map((line) => line.text)
    .join("\n");
  const artifacts = discoverContractArtifacts(input.testPatch)
    .filter((candidate) => containsArtifact(gold, candidate.artifact, candidate.category))
    .map(
      (candidate): ContractArtifactEvidence => ({
        ...candidate,
        introducedByGold: true,
        presentInPrompt: containsArtifact(input.prompt, candidate.artifact, candidate.category),
        presentInBase: input.baseArtifacts.has(candidate.artifact),
      }),
    );
  const blockers = artifacts
    .filter((artifact) => !artifact.presentInPrompt && !artifact.presentInBase)
    .map(
      (artifact) =>
        `held-out tests assert gold-only ${artifact.category} ${JSON.stringify(artifact.artifact)} at ${artifact.testLocations.join(", ")}`,
    );
  return { schemaVersion: 1, artifacts, blockers };
}

export function resolveCouplingReview(
  evidence: CouplingEvidence,
  review: CouplingReviewInput,
): CouplingReviewResolution {
  const unresolvedArtifacts = evidence.artifacts
    .filter((artifact) => !artifact.presentInBase && !artifact.presentInPrompt)
    .map((artifact) => artifact.artifact);
  const reviewedArtifacts = new Set(review.findings.map((finding) => finding.artifact));
  const missingArtifacts = unresolvedArtifacts.filter(
    (artifact) => !reviewedArtifacts.has(artifact),
  );
  const goldOnlyArtifacts = review.findings
    .filter((finding) => finding.disposition === "gold_only")
    .map((finding) => finding.artifact);
  const verdict =
    review.verdict === "coupled" || missingArtifacts.length > 0 || goldOnlyArtifacts.length > 0
      ? "coupled"
      : "clean";
  const reason =
    missingArtifacts.length > 0
      ? `review did not resolve deterministic coupling evidence for: ${missingArtifacts.join(", ")}`
      : goldOnlyArtifacts.length > 0 && review.verdict === "clean"
        ? `review identified gold-only artifacts: ${goldOnlyArtifacts.join(", ")}`
        : review.reason;
  return { verdict, reason, missingArtifacts, goldOnlyArtifacts };
}

export async function scanBaseContractArtifacts(
  baseDirectory: string,
  scratchDirectory: string,
  artifacts: readonly { readonly artifact: string }[],
): Promise<ReadonlySet<string>> {
  const values = [...new Set(artifacts.map((artifact) => artifact.artifact))].filter(
    (artifact) => !artifact.includes("\n") && artifact.length > 0,
  );
  if (values.length === 0) {
    return new Set();
  }
  const patterns = join(scratchDirectory, "coupling-patterns.txt");
  await writeFile(patterns, `${values.join("\n")}\n`);
  const result = await runCommand(
    "rg",
    [
      "--fixed-strings",
      "--only-matching",
      "--no-filename",
      "--hidden",
      "--glob",
      "!.git/**",
      "--file",
      patterns,
      baseDirectory,
    ],
    { allowFailure: true },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`failed to scan base repository for contract artifacts: ${result.stderr}`);
  }
  return new Set(result.stdout.split("\n").filter((value) => value.length > 0));
}

function addedLines(patch: string): readonly AddedLine[] {
  const lines: AddedLine[] = [];
  let path = "unknown";
  for (const [index, line] of patch.split("\n").entries()) {
    if (line.startsWith("diff --git a/")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      path = match?.[2] ?? "unknown";
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.push({ location: `${path}:patch-line-${index + 1}`, text: line.slice(1) });
    }
  }
  return lines;
}

function contractArtifacts(
  line: string,
): readonly { artifact: string; category: ContractArtifactCategory }[] {
  const artifacts: { artifact: string; category: ContractArtifactCategory }[] = [];
  const quoted = /(["'`])((?:\\.|.)*?)\1/g;
  for (const match of line.matchAll(quoted)) {
    const artifact = unescapeLiteral(match[2] ?? "");
    const start = match.index ?? 0;
    const prefix = line.slice(0, start);
    const suffix = line.slice(start + match[0].length);
    const category = classifyQuotedArtifact(artifact, prefix, suffix, line);
    if (category) {
      artifacts.push({ artifact, category });
    }
  }
  const bareKey = /(?:^\s*|[{,]\s*)([A-Za-z][A-Za-z0-9_]{2,63})\s*:/g;
  for (const match of line.matchAll(bareKey)) {
    if (match[1]) {
      artifacts.push({ artifact: match[1], category: "field_name" });
    }
  }
  const member = /\.([A-Za-z][A-Za-z0-9_]{2,63})\b/g;
  for (const match of line.matchAll(member)) {
    if (match[1]) {
      artifacts.push({ artifact: match[1], category: "field_name" });
    }
  }
  return artifacts;
}

function classifyQuotedArtifact(
  artifact: string,
  prefix: string,
  suffix: string,
  line: string,
): ContractArtifactCategory | undefined {
  if (/^\/[A-Za-z0-9]/.test(artifact) && !/\s/.test(artifact)) {
    return "endpoint_path";
  }
  if (/^[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;.*)?$/i.test(artifact)) {
    return "media_type";
  }
  if (/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(artifact)) {
    if (/^\s*:/.test(suffix) || (/\[\s*$/.test(prefix) && /^\s*\]/.test(suffix))) {
      return "field_name";
    }
    if (/headers?|content-type/i.test(line) && artifact.includes("-")) {
      return "header_name";
    }
  }
  return undefined;
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\([\\"'`])/g, "$1");
}

function containsArtifact(
  text: string,
  artifact: string,
  category: ContractArtifactCategory,
): boolean {
  if (category !== "field_name") {
    return text.includes(artifact);
  }
  const escaped = artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`).test(text);
}
