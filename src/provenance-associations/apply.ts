import { readFile } from "node:fs/promises";
import { assertPullRequestBelongsToRepository, githubRepository } from "../github.js";
import { sha256 } from "../hash.js";
import type { ProvenanceMessage } from "../provenance.js";
import {
  compareAssociationMessages,
  isLocalSourceType,
  type LocalSourceType,
  type MergedPullRequest,
  messageKey,
  provenanceAssociationManifestSchema,
  sessionSelector,
} from "./shared.js";

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
