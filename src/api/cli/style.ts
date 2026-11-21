/**
 * Colors for what the CLI prints, in the Dari CLI's palette (the same one `tui.ts` draws prompts
 * with). Only on a terminal, and never with NO_COLOR, so piped output and JSON stay plain.
 */

import { ansi } from "./tui.js";

type Stream = { isTTY?: boolean };

const enabled = (stream: Stream) =>
  stream.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function painter(stream: Stream) {
  const paint = (code: string) => (text: string) =>
    enabled(stream) ? `${code}${text}${ansi.reset}` : text;
  return {
    on: () => enabled(stream),
    bold: paint(ansi.bold),
    dim: paint(ansi.gray),
    accent: paint(ansi.coral),
    cyan: paint(ansi.cyan),
    green: paint(ansi.green),
    red: paint(ansi.red),
    heading: paint(`${ansi.bold}${ansi.gray}`),
  };
}

/** For stdout: tables, details, help. */
export const out = painter(process.stdout);
/** For stderr: errors and progress. */
export const err = painter(process.stderr);

/** Printable width, skipping escape sequences. */
export function visibleWidth(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal escapes
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

const DONE = new Set([
  "accepted",
  "approved",
  "built",
  "complete",
  "completed",
  "current",
  "done",
  "passed",
  "ready",
  "succeeded",
  "success",
]);
const FAILED = new Set(["error", "errored", "failed", "failure", "rejected", "timed_out"]);
const RUNNING = new Set([
  "building",
  "generating",
  "in_progress",
  "pending",
  "queued",
  "running",
  "started",
  "submitted",
]);

/**
 * A status with a mark that reads without color (✓ done, ✗ failed, ● running, ○ anything else),
 * so status is clear by shape and lightness, not hue alone.
 */
export function status(value: string): string {
  const key = value.toLowerCase();
  if (DONE.has(key)) return `${out.green("✓")} ${value}`;
  if (FAILED.has(key)) return `${out.red("✗")} ${out.bold(value)}`;
  if (RUNNING.has(key)) return `${out.cyan("●")} ${value}`;
  return `${out.dim("○")} ${out.dim(value)}`;
}
