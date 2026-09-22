import type { AgentFeedEvent } from "../../../src/agent-feed";

const eventBody =
  "mt-2 max-w-[96ch] font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere text-foreground site:text-sm site:leading-6";
const summaryClass =
  "grid min-h-10 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand [&::-webkit-details-marker]:hidden sm:px-4";

export function AgentTraceEvent({ event }: { event: AgentFeedEvent }) {
  const time = event.timestamp ? formatEventTime(event.timestamp) : "";

  if (event.kind === "message" || event.kind === "error") {
    return (
      <article className="border-t border-border px-3 py-3 first:border-t-0 sm:px-4">
        <EventHeading
          label={event.kind === "error" ? "Provider Error" : "Model Output"}
          tone={event.kind === "error" ? "error" : "model"}
          timestamp={event.timestamp}
          time={time}
        />
        <pre className={eventBody}>{formatTraceText(event.text)}</pre>
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
          className="text-[10px] text-muted-foreground before:content-['▸'] group-open/event:before:content-['▾']"
        />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs font-medium text-brand site:text-sm">
              {label}
            </span>
            {detail && (
              <span className="truncate font-mono text-xs text-muted-foreground site:text-sm">
                · {detail}
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
            {eventPreview(text, emptyPreview)}
          </span>
        </span>
        {time && (
          <time
            className="self-start font-mono text-xs text-muted-foreground"
            dateTime={event.timestamp}
          >
            {time}
          </time>
        )}
      </summary>
      <div className="border-t border-border/70 bg-muted/30 px-3 py-3 sm:px-4 sm:pl-9">
        <p className="m-0 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {event.kind === "tool" ? "Arguments" : "Returned to Model"}
        </p>
        <pre className={eventBody}>{formatTraceText(text) || emptyPreview}</pre>
      </div>
    </details>
  );
}

function EventHeading({
  label,
  tone,
  timestamp,
  time,
}: {
  label: string;
  tone: "model" | "error";
  timestamp?: string;
  time: string;
}) {
  return (
    <header className="flex items-baseline justify-between gap-3">
      <span
        className={`font-mono text-xs font-medium site:text-sm ${tone === "error" ? "text-destructive" : "text-brand"}`}
      >
        {label}
      </span>
      {time && (
        <time className="font-mono text-xs text-muted-foreground" dateTime={timestamp}>
          {time}
        </time>
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

function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
}
