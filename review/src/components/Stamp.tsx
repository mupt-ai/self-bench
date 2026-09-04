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
  big = false,
  children,
}: {
  tone?: Tone;
  big?: boolean;
  children: React.ReactNode;
}) {
  return <span className={`stamp ${tone} ${big ? "big" : ""}`.trim()}>{children}</span>;
}

export function stageLabel(stage?: string, status?: string): string {
  if (!stage) return status ?? "";
  if (stage === "accepted") return "accepted";
  if (stage === "infrastructure") return "infra failed";
  if (stage === "in_progress") return status?.replace(/_/g, " ") ?? "in progress";
  if (status === "archived") return `reached · ${stage}`;
  return `rejected · ${stage}`;
}
