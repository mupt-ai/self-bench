import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import { assertPullRequestBelongsToRepository, githubRepository } from "./github.js";
import { runCommand } from "./process.js";

export type SessionProvenanceFormat = "codex" | "claude-code" | "pi" | "generic";

const provenanceMessageBaseSchema = z.object({
  sessionId: z.string().min(1),
  messageIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
});

const localProvenanceMessageSchema = provenanceMessageBaseSchema
  .extend({
    sourceType: z.enum(["codex", "claude-code", "pi", "generic"]),
    sourcePr: z.number().int().positive().optional(),
    sourceUrl: z.string().url().optional(),
  })
  .refine(
    (message) => (message.sourcePr === undefined) === (message.sourceUrl === undefined),
    "sourcePr and sourceUrl must be supplied together",
  );

export const provenanceMessageSchema = z.union([
  localProvenanceMessageSchema,
  provenanceMessageBaseSchema.extend({
    sourceType: z.literal("github-pull-request"),
    sourcePr: z.number().int().positive(),
    sourceUrl: z.string().url(),
  }),
]);

export type ProvenanceMessage = z.infer<typeof provenanceMessageSchema>;

export interface LocalSessionMetadata {
  readonly sourceType: SessionProvenanceFormat;
  readonly sessionId: string;
  readonly path: string;
  readonly modifiedAt: string;
}

export interface RepositoryProvenanceCollection {
  readonly messages: readonly ProvenanceMessage[];
  readonly sessions: readonly LocalSessionMetadata[];
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

const SOURCE_ROOTS: readonly [SessionProvenanceFormat, string][] = [
  ["pi", ".pi/agent/sessions"],
  ["claude-code", ".claude/projects"],
  ["codex", ".codex/sessions"],
  ["codex", ".codex/archived_sessions"],
];

const GITHUB_PULL_REQUEST_LIMIT = 500;
const MAX_GITHUB_BODY_LENGTH = 12_000;

const INJECTED_PREFIXES = [
  "# AGENTS.md instructions",
  "# Review Guidelines",
  "<environment_context>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<skills_instructions>",
  "<apps_instructions>",
  "<plugins_instructions>",
  "<skill name=",
  "Base directory for this skill:",
  "## Memory",
] as const;

export async function collectRepositoryProvenance(
  repositoryPath: string,
  homeDirectory: string,
): Promise<ProvenanceMessage[]> {
  return [
    ...(await collectRepositoryProvenanceWithMetadata(repositoryPath, homeDirectory)).messages,
  ];
}

export async function collectRepositoryProvenanceWithMetadata(
  repositoryPath: string,
  homeDirectory: string,
): Promise<RepositoryProvenanceCollection> {
  const worktrees = await repositoryWorktrees(repositoryPath);
  const encodedWorktrees = worktrees.flatMap((path) => [path, encodeSessionPath(path)]);
  const messages: ProvenanceMessage[] = [];
  const sessions: LocalSessionMetadata[] = [];

  for (const [format, relativeRoot] of SOURCE_ROOTS) {
    const root = join(homeDirectory, relativeRoot);
    for (const path of await listJsonFiles(root)) {
      const raw = await readFile(path, "utf8").catch(() => undefined);
      if (
        !raw ||
        !encodedWorktrees.some((needle) => raw.includes(needle) || path.includes(needle))
      ) {
        continue;
      }
      const extracted = extractProvenanceMessages(raw, format, basename(path));
      if (extracted.length === 0) {
        continue;
      }
      messages.push(...extracted);
      const file = await stat(path).catch(() => undefined);
      if (file) {
        const sessionIds = new Set(extracted.map((message) => message.sessionId));
        for (const sessionId of sessionIds) {
          sessions.push({
            sourceType: format,
            sessionId,
            path: displaySessionPath(path, homeDirectory),
            modifiedAt: file.mtime.toISOString(),
          });
        }
      }
    }
  }

  return { messages: deduplicateMessages(messages), sessions };
}

export async function collectGitHubPullRequestProvenance(
  repositoryUrl: string,
  token?: string,
  signal?: AbortSignal,
): Promise<ProvenanceMessage[]> {
  const repository = githubRepository(repositoryUrl);
  const result = await runCommand(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "merged",
      "--limit",
      String(GITHUB_PULL_REQUEST_LIMIT),
      "--json",
      "number,title,body,url,author,isDraft,additions,deletions,changedFiles",
    ],
    {
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
      ...(signal ? { signal } : {}),
    },
  );
  return extractGitHubPullRequestProvenance(result.stdout, repositoryUrl);
}

export function extractGitHubPullRequestProvenance(
  raw: string,
  repositoryUrl: string,
): ProvenanceMessage[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub pull request response must be an array");
  }
  const repository = githubRepository(repositoryUrl);
  const messages: ProvenanceMessage[] = [];
  for (const value of parsed) {
    if (!isRecord(value) || value.isDraft === true || !isHumanAuthor(value.author)) {
      continue;
    }
    const sourcePr = positiveIntegerValue(value.number);
    const sourceUrl = typeof value.url === "string" ? value.url : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const body = typeof value.body === "string" ? value.body.trim() : "";
    const changedLines = nonnegativeNumber(value.additions) + nonnegativeNumber(value.deletions);
    const changedFiles = nonnegativeNumber(value.changedFiles);
    if (!sourcePr || !sourceUrl || !title || changedLines < 20 || changedFiles < 1) {
      continue;
    }
    assertPullRequestBelongsToRepository(repositoryUrl, sourceUrl, sourcePr);
    const content = redactSecrets(
      body && body.length <= MAX_GITHUB_BODY_LENGTH ? `${title}\n\n${body}` : title,
    );
    messages.push({
      sourceType: "github-pull-request",
      sessionId: `github:${repository}#${sourcePr}`,
      messageIndex: 0,
      content,
      sourcePr,
      sourceUrl,
    });
  }
  return messages;
}

export function combineRunProvenance(
  repositoryUrl: string,
  local: readonly ProvenanceMessage[],
  github: readonly ProvenanceMessage[],
): ProvenanceMessage[] {
  const explicitlyAssociatedPrs = new Set<number>();
  for (const message of local) {
    if (message.sourcePr === undefined || message.sourceUrl === undefined) {
      continue;
    }
    assertPullRequestBelongsToRepository(repositoryUrl, message.sourceUrl, message.sourcePr);
    explicitlyAssociatedPrs.add(message.sourcePr);
  }
  return [
    ...local,
    ...github.filter(
      (message) =>
        message.sourceType !== "github-pull-request" ||
        !explicitlyAssociatedPrs.has(message.sourcePr),
    ),
  ];
}

export function assertProvenanceMatchesPullRequest(
  message: ProvenanceMessage,
  sourcePr: number,
  sourceUrl: string,
  provenance: readonly ProvenanceMessage[] = [message],
): void {
  if (
    (message.sourcePr !== undefined || message.sourceUrl !== undefined) &&
    (message.sourcePr !== sourcePr || message.sourceUrl !== sourceUrl)
  ) {
    throw new Error(
      `pull request ${sourceUrl}#${sourcePr} does not match provenance ${message.sourceUrl}#${message.sourcePr}`,
    );
  }
  const hasExplicitLocalAssociation = provenance.some(
    (item) => item.sourceType !== "github-pull-request" && item.sourcePr === sourcePr,
  );
  if (
    hasExplicitLocalAssociation &&
    message.sourceType !== "github-pull-request" &&
    (message.sourcePr !== sourcePr || message.sourceUrl !== sourceUrl)
  ) {
    throw new Error(
      `pull request ${sourceUrl}#${sourcePr} has explicit local provenance; unbound local provenance cannot be selected`,
    );
  }
}

export function extractProvenanceMessages(
  raw: string,
  format: SessionProvenanceFormat | "auto" = "auto",
  fallbackSessionId = "unknown",
): ProvenanceMessage[] {
  const records = readRecords(raw);
  const resolved = format === "auto" ? detectFormat(records) : format;
  const sessionId = findSessionId(records, resolved) ?? fallbackSessionId;
  const messages = extractTrace(records, resolved);
  let messageIndex = 0;
  const result: ProvenanceMessage[] = [];
  for (const [role, rawContent] of messages) {
    if (role !== "user") {
      continue;
    }
    const content = redactSecrets(rawContent.trim());
    if (!content || looksInjected(content)) {
      continue;
    }
    result.push({ sourceType: resolved, sessionId, messageIndex, content });
    messageIndex += 1;
  }
  return result;
}

function readRecords(raw: string): JsonRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord);
    }
    if (isRecord(parsed)) {
      const messages = parsed.messages;
      return Array.isArray(messages) ? messages.filter(isRecord) : [parsed];
    }
    return [];
  } catch {
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter(isRecord);
  }
}

function detectFormat(records: readonly JsonRecord[]): SessionProvenanceFormat {
  if (
    records.some((record) =>
      ["event_msg", "response_item", "session_meta"].includes(String(record.type)),
    )
  ) {
    return "codex";
  }
  if (
    records.some(
      (record) => "sessionId" in record && ["user", "assistant"].includes(String(record.type)),
    )
  ) {
    return "claude-code";
  }
  if (records.some((record) => record.type === "message" && "parentId" in record)) {
    return "pi";
  }
  return "generic";
}

function extractTrace(
  records: readonly JsonRecord[],
  format: SessionProvenanceFormat,
): readonly ["user" | "assistant", string][] {
  switch (format) {
    case "codex":
      return codexTrace(records);
    case "claude-code":
      return claudeTrace(records);
    case "pi":
      return nestedMessageTrace(records);
    case "generic":
      return genericTrace(records);
  }
}

function codexTrace(records: readonly JsonRecord[]): readonly ["user" | "assistant", string][] {
  const eventMessages: ["user" | "assistant", string][] = [];
  for (const record of records) {
    if (record.type !== "event_msg" || !isRecord(record.payload)) {
      continue;
    }
    const role =
      record.payload.type === "user_message"
        ? "user"
        : record.payload.type === "agent_message"
          ? "assistant"
          : undefined;
    if (role && typeof record.payload.message === "string") {
      eventMessages.push([role, record.payload.message]);
    }
  }
  if (eventMessages.some(([role]) => role === "user")) {
    return eventMessages;
  }

  const messages: ["user" | "assistant", string][] = [];
  for (const record of records) {
    if (
      record.type !== "response_item" ||
      !isRecord(record.payload) ||
      record.payload.type !== "message"
    ) {
      continue;
    }
    const role = normalizeRole(record.payload.role);
    const content = contentText(record.payload.content);
    if (role && content) {
      messages.push([role, content]);
    }
  }
  return messages;
}

function claudeTrace(records: readonly JsonRecord[]): readonly ["user" | "assistant", string][] {
  const messages: ["user" | "assistant", string][] = [];
  for (const record of records) {
    if (
      !["user", "assistant"].includes(String(record.type)) ||
      record.sourceToolAssistantUUID !== undefined
    ) {
      continue;
    }
    if (!isRecord(record.message)) {
      continue;
    }
    const role = normalizeRole(record.message.role);
    const content = contentText(record.message.content);
    if (role && content) {
      messages.push([role, content]);
    }
  }
  return messages;
}

function nestedMessageTrace(
  records: readonly JsonRecord[],
): readonly ["user" | "assistant", string][] {
  const messages: ["user" | "assistant", string][] = [];
  for (const record of records) {
    if (record.type !== "message" || !isRecord(record.message)) {
      continue;
    }
    const role = normalizeRole(record.message.role);
    const content = contentText(record.message.content);
    if (role && content) {
      messages.push([role, content]);
    }
  }
  return messages;
}

function genericTrace(records: readonly JsonRecord[]): readonly ["user" | "assistant", string][] {
  const messages: ["user" | "assistant", string][] = [];
  for (const record of records) {
    const directRole = normalizeRole(record.role);
    const directContent = contentText(record.content);
    if (directRole && directContent) {
      messages.push([directRole, directContent]);
      continue;
    }
    if (!isRecord(record.message)) {
      continue;
    }
    const role = normalizeRole(record.message.role);
    const content = contentText(record.message.content);
    if (role && content) {
      messages.push([role, content]);
    }
  }
  return messages;
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      if (!isRecord(item) || !["text", "input_text"].includes(String(item.type))) {
        return [];
      }
      return typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n\n");
}

function findSessionId(
  records: readonly JsonRecord[],
  format: SessionProvenanceFormat,
): string | undefined {
  for (const record of records) {
    if (format === "codex" && record.type === "session_meta" && isRecord(record.payload)) {
      if (typeof record.payload.id === "string") {
        return record.payload.id;
      }
    }
    if (format === "claude-code" && typeof record.sessionId === "string") {
      return record.sessionId;
    }
    if (format === "pi" && record.type === "session" && typeof record.id === "string") {
      return record.id;
    }
  }
  return undefined;
}

function normalizeRole(value: unknown): "user" | "assistant" | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function looksInjected(content: string): boolean {
  const trimmed = content.trimStart();
  return INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

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
  ];
  return replacements.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    value,
  );
}

async function repositoryWorktrees(repositoryPath: string): Promise<string[]> {
  const result = await runCommand("git", ["-C", repositoryPath, "worktree", "list", "--porcelain"]);
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function listJsonFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function encodeSessionPath(path: string): string {
  return path.replaceAll("/", "-");
}

function displaySessionPath(path: string, homeDirectory: string): string {
  const fromHome = relative(homeDirectory, path);
  return fromHome && !fromHome.startsWith("..") ? `~/${fromHome}` : path;
}

function deduplicateMessages(messages: readonly ProvenanceMessage[]): ProvenanceMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.sourceType}\0${message.sessionId}\0${message.messageIndex}\0${message.content}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isHumanAuthor(value: unknown): boolean {
  if (!isRecord(value) || value.is_bot === true || typeof value.login !== "string") {
    return false;
  }
  return !value.login.toLowerCase().endsWith("[bot]");
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
