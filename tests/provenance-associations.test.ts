import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/hash.js";
import { extractProvenanceMessages, type ProvenanceMessage } from "../src/provenance.js";
import {
  applyProvenanceAssociationManifests,
  associationSessionSummaries,
  createProvenanceAssociationManifest,
} from "../src/provenance-associations.js";

const repositoryUrl = "https://github.com/example/project.git";
const sourceUrl = "https://github.com/example/project/pull/42";
const messages: ProvenanceMessage[] = [
  {
    sourceType: "pi",
    sessionId: "session-b",
    messageIndex: 0,
    content: "Authorization: Bearer [REDACTED] add routing",
  },
  {
    sourceType: "pi",
    sessionId: "session-a",
    messageIndex: 1,
    content: "Preserve the fallback",
  },
  {
    sourceType: "pi",
    sessionId: "session-a",
    messageIndex: 0,
    content: "Build the public routing API",
  },
  {
    sourceType: "generic",
    sessionId: "generic-session",
    messageIndex: 0,
    content: "Do not offer this session",
  },
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provenance association manifests", () => {
  test("lists local sessions with identifying file metadata but without message content", () => {
    expect(
      associationSessionSummaries(messages, [
        {
          sourceType: "pi",
          sessionId: "session-a",
          path: "~/.pi/agent/sessions/a.jsonl",
          modifiedAt: "2026-08-24T01:00:00.000Z",
        },
        {
          sourceType: "pi",
          sessionId: "session-a",
          path: "~/.pi/agent/sessions/archived-a.jsonl",
          modifiedAt: "2026-08-24T02:00:00.000Z",
        },
        {
          sourceType: "pi",
          sessionId: "session-b",
          path: "~/.pi/agent/sessions/b.jsonl",
          modifiedAt: "2026-08-23T01:00:00.000Z",
        },
      ]),
    ).toEqual([
      {
        selector: "pi:session-a",
        sourceType: "pi",
        sessionId: "session-a",
        messageCount: 2,
        modifiedAt: "2026-08-24T02:00:00.000Z",
        paths: ["~/.pi/agent/sessions/a.jsonl", "~/.pi/agent/sessions/archived-a.jsonl"],
      },
      {
        selector: "pi:session-b",
        sourceType: "pi",
        sessionId: "session-b",
        messageCount: 1,
        modifiedAt: "2026-08-23T01:00:00.000Z",
        paths: ["~/.pi/agent/sessions/b.jsonl"],
      },
    ]);
  });

  test("hashes the exact sanitized and whitespace-normalized retained message", () => {
    const raw = [
      { type: "session", id: "normalized-session" },
      {
        type: "message",
        parentId: "parent",
        message: {
          role: "user",
          content: "  Authorization: Bearer private-token build routing.\n\n",
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const retained = extractProvenanceMessages(raw, "pi");
    const manifest = createProvenanceAssociationManifest({
      repositoryUrl,
      pullRequest: { sourcePr: 42, sourceUrl },
      messages: retained,
      sessionSelectors: ["pi:normalized-session"],
    });

    expect(retained[0]?.content).toBe("Authorization: Bearer [REDACTED] build routing.");
    expect(manifest.messages[0]?.contentSha256).toBe(
      sha256("Authorization: Bearer [REDACTED] build routing."),
    );
  });

  test("creates a deterministic text-free manifest for exact sanitized messages", () => {
    const manifest = createProvenanceAssociationManifest({
      repositoryUrl,
      pullRequest: { sourcePr: 42, sourceUrl },
      messages,
      sessionSelectors: ["pi:session-a"],
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      repository: "example/project",
      sourcePr: 42,
      sourceUrl,
      messages: [
        {
          sourceType: "pi",
          sessionId: "session-a",
          messageIndex: 0,
          contentSha256: "5a14476a9c1591b902fac983e908ac96a660f456096ae6bf4802816ac1ffcbf9",
        },
        {
          sourceType: "pi",
          sessionId: "session-a",
          messageIndex: 1,
          contentSha256: "a7ed6f18e665f3de35513c1b9e5aefc5b1bdcaa1f8e1951e5d970ff79d299343",
        },
      ],
    });
    expect(JSON.stringify(manifest)).not.toContain("Build the public routing API");
    expect(JSON.stringify(manifest)).not.toContain("REDACTED");
  });

  test("applies a valid binding without changing exact message content", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-association-"));
    roots.push(root);
    const path = join(root, "association.json");
    const manifest = createProvenanceAssociationManifest({
      repositoryUrl,
      pullRequest: { sourcePr: 42, sourceUrl },
      messages,
      sessionSelectors: ["pi:session-a"],
    });
    await writeFile(path, JSON.stringify(manifest));

    const associated = await applyProvenanceAssociationManifests(messages, repositoryUrl, [path]);

    expect(associated.map(({ content }) => content)).toEqual(
      messages.map(({ content }) => content),
    );
    expect(associated[1]).toMatchObject({ sourcePr: 42, sourceUrl });
    expect(associated[2]).toMatchObject({ sourcePr: 42, sourceUrl });
    expect(associated[0]).toEqual(messages[0]);
  });

  test("rejects repository drift, content drift, and conflicting associations", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-association-invalid-"));
    roots.push(root);
    const manifest = createProvenanceAssociationManifest({
      repositoryUrl,
      pullRequest: { sourcePr: 42, sourceUrl },
      messages,
      sessionSelectors: ["pi:session-a"],
    });
    const wrongRepository = join(root, "wrong-repository.json");
    const changedContent = join(root, "changed-content.json");
    const inventedText = join(root, "invented-text.json");
    const duplicate = join(root, "duplicate.json");
    await Promise.all([
      writeFile(wrongRepository, JSON.stringify({ ...manifest, repository: "other/project" })),
      writeFile(
        changedContent,
        JSON.stringify({
          ...manifest,
          messages: manifest.messages.map((message, index) =>
            index === 0 ? { ...message, contentSha256: "a".repeat(64) } : message,
          ),
        }),
      ),
      writeFile(
        inventedText,
        JSON.stringify({
          ...manifest,
          messages: [{ ...manifest.messages[0], content: "Invented request text" }],
        }),
      ),
      writeFile(duplicate, JSON.stringify(manifest)),
    ]);

    await expect(
      applyProvenanceAssociationManifests(messages, repositoryUrl, [wrongRepository]),
    ).rejects.toThrow("belongs to other/project");
    await expect(
      applyProvenanceAssociationManifests(messages, repositoryUrl, [changedContent]),
    ).rejects.toThrow("does not match local session");
    await expect(
      applyProvenanceAssociationManifests(messages, repositoryUrl, [inventedText]),
    ).rejects.toThrow();
    await expect(
      applyProvenanceAssociationManifests(
        [
          ...messages,
          {
            sourceType: "pi",
            sessionId: "session-a",
            messageIndex: 2,
            content: "A later follow-up",
          },
        ],
        repositoryUrl,
        [duplicate],
      ),
    ).rejects.toThrow("does not match local session");
    await expect(
      applyProvenanceAssociationManifests(messages, repositoryUrl, [duplicate, duplicate]),
    ).rejects.toThrow("associated more than once");
  });
});
