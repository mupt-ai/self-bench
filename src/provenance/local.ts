import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { runCommand } from "../process.js";
import { extractProvenanceMessages } from "./session.js";
import type {
  LocalSessionMetadata,
  ProvenanceMessage,
  RepositoryProvenanceCollection,
  SessionProvenanceFormat,
} from "./types.js";

const SOURCE_ROOTS: readonly [SessionProvenanceFormat, string][] = [
  ["pi", ".pi/agent/sessions"],
  ["claude-code", ".claude/projects"],
  ["codex", ".codex/sessions"],
  ["codex", ".codex/archived_sessions"],
];

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
