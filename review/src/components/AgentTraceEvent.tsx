import type { AgentFeedEvent } from "../../../src/agent-feed";

const eventText =
  "max-w-[96ch] font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere text-foreground";
const summaryClass =
  "grid min-h-10 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-3 py-2 text-left leading-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand [&::-webkit-details-marker]:hidden sm:px-4";

export function AgentTraceEvent({ event }: { event: AgentFeedEvent }) {
  const time = event.timestamp ? formatEventTime(event.timestamp) : "";

  if (event.kind === "message") {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-t border-border px-3 py-2 first:border-t-0 sm:px-4">
        <pre className={`${eventText} min-w-0`}>{formatTraceText(event.text)}</pre>
        {time && (
          <time
            className="justify-self-end font-mono text-[10px] leading-5 text-muted-foreground"
            dateTime={event.timestamp}
          >
            {time}
          </time>
        )}
      </div>
    );
  }

  if (event.kind === "error") {
    return (
      <article className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t border-border px-3 py-2 first:border-t-0 sm:px-4">
        <pre className={`${eventText} min-w-0`}>{formatTraceText(event.text)}</pre>
        <EventHeading
          label="Provider Error"
          time={time}
          timestamp={event.timestamp}
          align="right"
        />
      </article>
    );
  }

  const tool = event.kind === "tool" ? parseToolCall(event.text) : undefined;
  const label = event.kind === "tool" ? "Tool Call" : "Tool Output";
  const detail = event.kind === "tool" ? tool?.name : "Returned to Model";
  const text = event.kind === "tool" ? (tool?.body ?? event.text) : event.text;
  const emptyPreview = event.kind === "tool" ? "(no arguments)" : "(empty output)";

  return (
    <details className="group/event border-t border-border first:border-t-0">
      <summary className={summaryClass}>
        <span
          aria-hidden="true"
          className="mt-0.5 text-[10px] text-muted-foreground before:content-['▸'] group-open/event:before:content-['▾']"
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs font-medium text-brand">{label}</span>
            {detail && (
              <span className="truncate font-mono text-xs text-muted-foreground">· {detail}</span>
            )}
          </span>
          <span className="block truncate font-mono text-[10px] leading-4 text-muted-foreground">
            {eventPreview(text, emptyPreview)}
          </span>
        </span>
        {time && (
          <time
            className="justify-self-end font-mono text-[10px] text-muted-foreground"
            dateTime={event.timestamp}
          >
            {time}
          </time>
        )}
      </summary>
      <div className="border-t border-border/70 bg-muted/30 px-3 py-2 sm:px-4 sm:pl-9">
        <p className="m-0 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {event.kind === "tool" ? "Arguments" : "Output"}
        </p>
        <pre className={`${eventText} mt-1`}>{formatTraceText(text) || emptyPreview}</pre>
      </div>
    </details>
  );
}

function EventHeading({
  label,
  time,
  timestamp,
  align = "left",
}: {
  label: string;
  time?: string;
  timestamp?: string;
  align?: "left" | "right";
}) {
  return (
    <header
      className={`flex w-full items-baseline gap-2 ${align === "right" ? "justify-end" : "justify-start"}`}
    >
      <span
        className={`font-mono font-medium ${align === "right" ? "text-[10px] text-destructive" : "text-xs text-destructive"}`}
      >
        {label}
      </span>
      {time && (
        <>
          <span aria-hidden="true" className="font-mono text-[10px] text-muted-foreground">
            ·
          </span>
          <time className="font-mono text-[10px] text-muted-foreground" dateTime={timestamp}>
            {time}
          </time>
        </>
      )}
    </header>
  );
}

export function parseToolCall(text: string): { name: string; body: string } | undefined {
  const newline = text.indexOf("\n");
  if (newline < 0) return text.trim() ? { name: text.trim(), body: "" } : undefined;
  const name = text.slice(0, newline).trim();
  return name ? { name, body: text.slice(newline + 1).trim() } : undefined;
}

export function formatTraceText(text: string): string {
  const value = text.trim();
  if (!value || !/^[[{]/.test(value)) return text;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return text;
  }
}

export function eventPreview(text: string, empty = "(empty)"): string {
  const value = text.trim();
  if (!value) return empty;
  if (/^[[{]/.test(value)) {
    try {
      return structuredPreview(JSON.parse(value));
    } catch {
      // Fall through to the raw first line for incomplete or non-JSON output.
    }
  }
  return truncatePreview(value.split("\n")[0]?.trim() || empty);
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function structuredPreview(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty array)";
    return truncatePreview(
      `${value.length} item${value.length === 1 ? "" : "s"} · ${scalarPreview(value[0])}`,
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "(empty object)";
    return truncatePreview(
      entries
        .slice(0, 2)
        .map(([key, entry]) => `${key}: ${scalarPreview(entry)}`)
        .join(" · "),
    );
  }
  return truncatePreview(scalarPreview(value));
}

function scalarPreview(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (value && typeof value === "object") return "{…}";
  return String(value).replace(/\s+/g, " ");
}

function truncatePreview(value: string): string {
  return value.length > 160 ? `${value.slice(0, 159)}…` : value;
}
