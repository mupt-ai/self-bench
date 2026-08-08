import { describe, expect, test } from "bun:test";
import {
  assertProvenanceMatchesPullRequest,
  extractGitHubPullRequestProvenance,
  extractProvenanceMessages,
  redactSecrets,
} from "../src/provenance.js";

describe("provenance sanitization", () => {
  test("extracts human Codex messages and ignores injected context", () => {
    const raw = [
      { type: "session_meta", payload: { id: "session-1" } },
      { type: "event_msg", payload: { type: "user_message", message: "Build the feature" } },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "# AGENTS.md instructions\nsecret" },
      },
      { type: "event_msg", payload: { type: "agent_message", message: "done" } },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");

    expect(extractProvenanceMessages(raw)).toEqual([
      {
        sourceType: "codex",
        sessionId: "session-1",
        messageIndex: 0,
        content: "Build the feature",
      },
    ]);
  });

  test("redacts provider, GitHub, and database credentials", () => {
    const value = redactSecrets(
      "Authorization: Bearer abc123 sk-abcdefghijklmnop postgres://u:p@host/db",
    );
    expect(value).not.toContain("abc123");
    expect(value).not.toContain("sk-abcdefghijklmnop");
    expect(value).not.toContain("postgres://");
  });

  test("extracts tier-eligible pull requests from non-bot GitHub authors", () => {
    const raw = JSON.stringify([
      {
        number: 42,
        title: "Add the public routing API",
        body: "Expose routing through the documented client.",
        url: "https://github.com/example/project/pull/42",
        author: { login: "human", is_bot: false },
        isDraft: false,
        additions: 90,
        deletions: 15,
        changedFiles: 4,
      },
      {
        number: 41,
        title: "Add a focused validation rule",
        body: "Reject malformed input.",
        url: "https://github.com/example/project/pull/41",
        author: { login: "human", is_bot: false },
        isDraft: false,
        additions: 22,
        deletions: 0,
        changedFiles: 1,
      },
      {
        number: 43,
        title: "Automated dependency update",
        body: "Generated",
        url: "https://github.com/example/project/pull/43",
        author: { login: "dependabot[bot]", is_bot: true },
        isDraft: false,
        additions: 120,
        deletions: 20,
        changedFiles: 5,
      },
      {
        number: 44,
        title: "Small fix",
        body: "Not hard mode.",
        url: "https://github.com/example/project/pull/44",
        author: { login: "human", is_bot: false },
        isDraft: false,
        additions: 10,
        deletions: 2,
        changedFiles: 1,
      },
    ]);

    expect(
      extractGitHubPullRequestProvenance(raw, "https://github.com/example/project.git"),
    ).toEqual([
      {
        sourceType: "github-pull-request",
        sessionId: "github:example/project#42",
        messageIndex: 0,
        content: "Add the public routing API\n\nExpose routing through the documented client.",
        sourcePr: 42,
        sourceUrl: "https://github.com/example/project/pull/42",
      },
      {
        sourceType: "github-pull-request",
        sessionId: "github:example/project#41",
        messageIndex: 0,
        content: "Add a focused validation rule\n\nReject malformed input.",
        sourcePr: 41,
        sourceUrl: "https://github.com/example/project/pull/41",
      },
    ]);
  });

  test("binds GitHub provenance to its exact pull request", () => {
    const message = extractGitHubPullRequestProvenance(
      JSON.stringify([
        {
          number: 42,
          title: "Add the public routing API",
          body: "",
          url: "https://github.com/example/project/pull/42",
          author: { login: "human", is_bot: false },
          additions: 100,
          deletions: 0,
          changedFiles: 3,
        },
      ]),
      "https://github.com/example/project",
    )[0];
    if (!message) {
      throw new Error("expected GitHub provenance fixture");
    }
    expect(() =>
      assertProvenanceMatchesPullRequest(message, 41, "https://github.com/example/project/pull/41"),
    ).toThrow("does not match provenance");
    expect(() =>
      assertProvenanceMatchesPullRequest(message, 42, "https://github.com/example/project/pull/42"),
    ).not.toThrow();
  });
});
