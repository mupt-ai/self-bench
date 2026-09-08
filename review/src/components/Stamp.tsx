import type React from "react";

export type Tone = "ok" | "bad" | "warn" | "live" | "";

export function toneFor(stage?: string, status?: string): Tone {
  if (stage === "accepted" || status === "accepted") return "ok";
  if (stage === "infrastructure" || status === "infrastructure_failed") return "warn";
  if (status === "rejected") return "bad";
  if (status === "archived") return "";
  if (stage === "in_progress" || (status && status !== "rejected")) return "live";
  return "";
}

export function Stamp({
  tone = "",
  children,
}: {
  tone?: Tone;
  big?: boolean;
  children: React.ReactNode;
}) {
  const colors: Record<Tone, string> = {
    "": "border-(--border) text-(--muted-fg)",
    ok: "border-(--ok-45) bg-(--ok-10) text-(--ok)",
    bad: "border-(--bad-50) bg-(--bad-10) text-(--bad-fg)",
    warn: "border-(--brand-40) bg-(--brand-10) text-(--warn-fg)",
    live: "border-(--brand-40) bg-(--brand-10) text-(--brand)",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-[11px] tracking-[0.14em] uppercase ${colors[tone]} ${tone ? "before:size-1.5 before:bg-current before:content-['']" : ""}`}
    >
      {children}
    </span>
  );
}

export function stageLabel(stage?: string, status?: string): string {
  if (!stage) return status ?? "";
  if (stage === "accepted") return "accepted";
  if (stage === "infrastructure") return "infra failed";
  if (stage === "in_progress") return status?.replace(/_/g, " ") ?? "in progress";
  if (status === "archived") return `reached · ${stage}`;
  return `rejected · ${stage}`;
}
