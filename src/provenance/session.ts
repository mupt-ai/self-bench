import { redactSecrets } from "./redact.js";
import { isRecord, type JsonRecord } from "./shared.js";
import type { ProvenanceMessage, SessionProvenanceFormat } from "./types.js";

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
