import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { assertPullRequestBelongsToRepository, githubRepository } from "./github.js";
import { sha256 } from "./hash.js";
import { runCommand } from "./process.js";
import type { LocalSessionMetadata, ProvenanceMessage } from "./provenance.js";

export {
  type MergedPullRequest,
  type ProvenanceAssociationManifest,
  provenanceAssociationManifestSchema,
} from "./provenance-associations/shared.js";

import {
  compareAssociationMessages,
  isLocalSourceType,
  type LocalSourceType,
  type MergedPullRequest,
  messageKey,
  type ProvenanceAssociationManifest,
  parseSessionSelector,
  provenanceAssociationManifestSchema,
  sessionSelector,
} from "./provenance-associations/shared.js";

export interface AssociationSessionSummary {
  readonly selector: string;
  readonly sourceType: LocalSourceType;
  readonly sessionId: string;
  readonly messageCount: number;
  readonly modifiedAt?: string;
  readonly paths?: readonly string[];
}

export function associationSessionSummaries(
  messages: readonly ProvenanceMessage[],
  metadata: readonly LocalSessionMetadata[] = [],
): AssociationSessionSummary[] {
  const metadataBySelector = new Map<string, { modifiedAt: string; paths: Set<string> }>();
  for (const session of metadata) {
    if (!isLocalSourceType(session.sourceType)) {
      continue;
    }
    const selector = sessionSelector(session.sourceType, session.sessionId);
    const existing = metadataBySelector.get(selector);
    metadataBySelector.set(selector, {
      modifiedAt:
        !existing || session.modifiedAt > existing.modifiedAt
          ? session.modifiedAt
          : existing.modifiedAt,
      paths: new Set([...(existing?.paths ?? []), session.path]),
    });
  }

  const counts = new Map<string, AssociationSessionSummary>();
  for (const message of messages) {
    if (!isLocalSourceType(message.sourceType)) {
      continue;
    }
    const selector = sessionSelector(message.sourceType, message.sessionId);
    const existing = counts.get(selector);
    const sessionMetadata = metadataBySelector.get(selector);
    counts.set(selector, {
      selector,
      sourceType: message.sourceType,
      sessionId: message.sessionId,
      messageCount: (existing?.messageCount ?? 0) + 1,
      ...(sessionMetadata
        ? {
            modifiedAt: sessionMetadata.modifiedAt,
            paths: [...sessionMetadata.paths].sort(),
          }
        : {}),
    });
  }
  return [...counts.values()].sort(
    (left, right) =>
      (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? "") ||
      left.selector.localeCompare(right.selector),
  );
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

export { applyProvenanceAssociationManifests } from "./provenance-associations/apply.js";
