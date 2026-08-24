import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { assertPullRequestBelongsToRepository, githubRepository } from "./github.js";
import { sha256 } from "./hash.js";
import { runCommand } from "./process.js";
import type { ProvenanceMessage, SessionProvenanceFormat } from "./provenance.js";

const localSourceTypeSchema = z.enum(["pi", "claude-code", "codex"]);
type LocalSourceType = z.infer<typeof localSourceTypeSchema>;

const associationMessageSchema = z
  .object({
    sourceType: localSourceTypeSchema,
    sessionId: z.string().min(1),
    messageIndex: z.number().int().nonnegative(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const provenanceAssociationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.string().regex(/^[^/]+\/[^/]+$/),
    sourcePr: z.number().int().positive(),
    sourceUrl: z.string().url(),
    messages: z.array(associationMessageSchema).min(1),
  })
  .strict();

export type ProvenanceAssociationManifest = z.infer<typeof provenanceAssociationManifestSchema>;

export interface AssociationSessionSummary {
  readonly selector: string;
  readonly sourceType: LocalSourceType;
  readonly sessionId: string;
  readonly messageCount: number;
}

export interface MergedPullRequest {
  readonly sourcePr: number;
  readonly sourceUrl: string;
}

export function associationSessionSummaries(
  messages: readonly ProvenanceMessage[],
): AssociationSessionSummary[] {
  const counts = new Map<string, AssociationSessionSummary>();
  for (const message of messages) {
    if (!isLocalSourceType(message.sourceType)) {
      continue;
    }
    const selector = sessionSelector(message.sourceType, message.sessionId);
    const existing = counts.get(selector);
    counts.set(selector, {
      selector,
      sourceType: message.sourceType,
      sessionId: message.sessionId,
      messageCount: (existing?.messageCount ?? 0) + 1,
    });
  }
  return [...counts.values()].sort((left, right) => left.selector.localeCompare(right.selector));
}

export function createProvenanceAssociationManifest(input: {
  readonly repositoryUrl: string;
  readonly pullRequest: MergedPullRequest;
  readonly messages: readonly ProvenanceMessage[];
  readonly sessionSelectors: readonly string[];
}): ProvenanceAssociationManifest {
  const repository = githubRepository(input.repositoryUrl);
  assertPullRequestBelongsToRepository(
    input.repositoryUrl,
    input.pullRequest.sourceUrl,
    input.pullRequest.sourcePr,
  );
  if (input.sessionSelectors.length === 0) {
    throw new Error("at least one --session is required to create an association manifest");
  }

  const selected = new Set(input.sessionSelectors.map(parseSessionSelector));
  if (selected.size !== input.sessionSelectors.length) {
    throw new Error("each --session selector must be unique");
  }
  const available = new Set(
    associationSessionSummaries(input.messages).map(({ selector }) => selector),
  );
  for (const selector of selected) {
    if (!available.has(selector)) {
      throw new Error(`local session ${selector} was not found for this repository`);
    }
  }

  const messageKeys = new Set<string>();
  const messages = input.messages
    .filter(
      (message): message is ProvenanceMessage & { sourceType: LocalSourceType } =>
        isLocalSourceType(message.sourceType) &&
        selected.has(sessionSelector(message.sourceType, message.sessionId)),
    )
    .map((message) => {
      const key = messageKey(message.sourceType, message.sessionId, message.messageIndex);
      if (messageKeys.has(key)) {
        throw new Error(`local provenance contains duplicate message identity ${key}`);
      }
      messageKeys.add(key);
      return {
        sourceType: message.sourceType,
        sessionId: message.sessionId,
        messageIndex: message.messageIndex,
        contentSha256: sha256(message.content),
      };
    })
    .sort(compareAssociationMessages);

  return provenanceAssociationManifestSchema.parse({
    schemaVersion: 1,
    repository,
    sourcePr: input.pullRequest.sourcePr,
    sourceUrl: input.pullRequest.sourceUrl,
    messages,
  });
}

export async function writeProvenanceAssociationManifest(
  path: string,
  manifest: ProvenanceAssociationManifest,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function applyProvenanceAssociationManifests(
  messages: readonly ProvenanceMessage[],
  repositoryUrl: string,
  paths: readonly string[],
): Promise<ProvenanceMessage[]> {
  if (paths.length === 0) {
    return [...messages];
  }
  const repository = githubRepository(repositoryUrl);
  const manifests = await Promise.all(
    paths.map(async (path) => {
      const value = JSON.parse(await readFile(path, "utf8"));
      return { path, manifest: provenanceAssociationManifestSchema.parse(value) };
    }),
  );
  const messageByKey = new Map<string, ProvenanceMessage>();
  for (const message of messages) {
    const key = messageKey(message.sourceType, message.sessionId, message.messageIndex);
    if (messageByKey.has(key)) {
      throw new Error(`local provenance contains duplicate message identity ${key}`);
    }
    messageByKey.set(key, message);
  }

  const associations = new Map<string, MergedPullRequest>();
  for (const { path, manifest } of manifests) {
    if (manifest.repository.toLowerCase() !== repository) {
      throw new Error(
        `association manifest ${path} belongs to ${manifest.repository}, not ${repository}`,
      );
    }
    assertPullRequestBelongsToRepository(repositoryUrl, manifest.sourceUrl, manifest.sourcePr);
    for (const selector of new Set(
      manifest.messages.map((message) => sessionSelector(message.sourceType, message.sessionId)),
    )) {
      const expected = manifest.messages
        .filter((message) => sessionSelector(message.sourceType, message.sessionId) === selector)
        .sort(compareAssociationMessages);
      const current = messages
        .filter(
          (message): message is ProvenanceMessage & { sourceType: LocalSourceType } =>
            isLocalSourceType(message.sourceType) &&
            sessionSelector(message.sourceType, message.sessionId) === selector,
        )
        .map((message) => ({
          sourceType: message.sourceType,
          sessionId: message.sessionId,
          messageIndex: message.messageIndex,
          contentSha256: sha256(message.content),
        }))
        .sort(compareAssociationMessages);
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error(`association manifest ${path} does not match local session ${selector}`);
      }
    }
    for (const reference of manifest.messages) {
      const key = messageKey(reference.sourceType, reference.sessionId, reference.messageIndex);
      const message = messageByKey.get(key);
      if (!message || sha256(message.content) !== reference.contentSha256) {
        throw new Error(`association manifest ${path} does not match local message ${key}`);
      }
      if (associations.has(key)) {
        throw new Error(`local message ${key} is associated more than once`);
      }
      associations.set(key, {
        sourcePr: manifest.sourcePr,
        sourceUrl: manifest.sourceUrl,
      });
    }
  }

  return messages.map((message) => {
    const association = associations.get(
      messageKey(message.sourceType, message.sessionId, message.messageIndex),
    );
    return association ? { ...message, ...association } : message;
  });
}

export async function resolveMergedPullRequest(
  repositoryUrl: string,
  sourcePr: number,
): Promise<MergedPullRequest> {
  const repository = githubRepository(repositoryUrl);
  const result = await runCommand("gh", [
    "pr",
    "view",
    String(sourcePr),
    "--repo",
    repository,
    "--json",
    "number,url,state,mergedAt",
  ]);
  const parsed = z
    .object({
      number: z.number().int().positive(),
      url: z.string().url(),
      state: z.string(),
      mergedAt: z.string().nullable(),
    })
    .parse(JSON.parse(result.stdout));
  if (parsed.number !== sourcePr) {
    throw new Error(`GitHub returned pull request ${parsed.number}; expected ${sourcePr}`);
  }
  assertPullRequestBelongsToRepository(repositoryUrl, parsed.url, sourcePr);
  if (parsed.state !== "MERGED" || !parsed.mergedAt) {
    throw new Error(`pull request ${repository}#${sourcePr} is not merged`);
  }
  return { sourcePr, sourceUrl: parsed.url };
}

function parseSessionSelector(value: string): string {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(`invalid session selector ${JSON.stringify(value)}; expected TYPE:SESSION_ID`);
  }
  const sourceType = value.slice(0, separator);
  localSourceTypeSchema.parse(sourceType);
  return sessionSelector(sourceType as LocalSourceType, value.slice(separator + 1));
}

function sessionSelector(sourceType: LocalSourceType, sessionId: string): string {
  return `${sourceType}:${sessionId}`;
}

function messageKey(
  sourceType: SessionProvenanceFormat | "github-pull-request",
  sessionId: string,
  messageIndex: number,
): string {
  return `${sourceType}:${sessionId}:${messageIndex}`;
}

function compareAssociationMessages(
  left: z.infer<typeof associationMessageSchema>,
  right: z.infer<typeof associationMessageSchema>,
): number {
  return (
    left.sourceType.localeCompare(right.sourceType) ||
    left.sessionId.localeCompare(right.sessionId) ||
    left.messageIndex - right.messageIndex
  );
}

function isLocalSourceType(value: string): value is LocalSourceType {
  return value === "pi" || value === "claude-code" || value === "codex";
}
