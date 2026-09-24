import React from "react";
import type { VerifyReport } from "../../../src/contracts/index";
import type { HarborLiveSnapshot } from "../../../src/generation/pipeline/harbor-live";
import { notice } from "../components/viewer-ui";
import type { VerifyRound, VerifyStepState } from "../lib/verify-rounds";
import type { TaskSource } from "../sources/types";
import { WorkPart } from "./WorkPart";

type GateResult = "Passed" | "Failed" | "Not Run";

const pre =
  "m-0 max-h-[420px] overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere text-foreground sm:px-4";

/** A verification: live Harbor progress while it runs, the report the agent gets once it ends. */
export function VerifyPart({
  round,
  source,
  active,
}: {
  round: VerifyRound;
  source: TaskSource;
  active: boolean;
}) {
  const report = useArtifact(source, round.report?.key, (text) => JSON.parse(text) as VerifyReport);
  const reportText = useArtifact(source, round.reportText?.key, (text) => text);
  const live = useArtifact(
    source,
    round.live?.key,
    (text) => JSON.parse(text) as HarborLiveSnapshot,
  );
  const status = report
    ? report.green
      ? "Passed"
      : "Failed"
    : round.report
      ? "Finished"
      : active
        ? "In Progress"
        : "Stopped";
  return (
    <WorkPart
      title={round.title}
      status={status}
      capturedAt={report ? undefined : live?.capturedAt}
    >
      <ul className="m-0 flex list-none flex-col gap-1 border-b border-border px-3 py-2 text-xs sm:px-4">
        {report
          ? reportGates(report).map(([label, result]) => (
              <li key={label} className="flex justify-between gap-3">
                <span>{label}</span>
                <span
                  className={
                    result === "Failed"
                      ? "text-(--bad-fg) site:text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {result}
                </span>
              </li>
            ))
          : round.steps.map((step) => (
              <li key={step.label} className="flex justify-between gap-3">
                <span>{step.label}</span>
                <span className="text-muted-foreground">
                  {stepLabel(step.state, active)}
                  {step.state === "running" && active && live
                    ? ` · ${elapsed(live.startedAt, live.capturedAt)}`
                    : ""}
                </span>
              </li>
            ))}
      </ul>
      {reportText ? (
        <pre className={pre}>{reportText}</pre>
      ) : live ? (
        <>
          {live.steps.length > 0 && <pre className={pre}>{live.steps.slice(-30).join("\n")}</pre>}
          {live.output.trim() && (
            <pre className={`${pre} border-t border-border text-muted-foreground`}>
              {live.output}
            </pre>
          )}
        </>
      ) : (
        <p className={notice}>
          {active ? "Waiting for verification output…" : "No verification output available."}
        </p>
      )}
    </WorkPart>
  );
}

function reportGates(report: VerifyReport): [string, GateResult][] {
  const gate = (gate: { ran: boolean; ok: boolean }): GateResult =>
    !gate.ran ? "Not Run" : gate.ok ? "Passed" : "Failed";
  return [
    ["Compile and Audit", report.compile.ok && report.audit.ok ? "Passed" : "Failed"],
    ["Image Build", gate(report.build)],
    ["Smoke", gate(report.smoke)],
    ["Tests Without Fix", gate(report.nop)],
    ["Tests With Fix", gate(report.oracle)],
  ];
}

/** How long the current Harbor run had been going at its latest snapshot. */
function elapsed(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function stepLabel(state: VerifyStepState, active: boolean): string {
  if (state === "done") return "Done";
  if (state === "running") return active ? "Running" : "Stopped";
  return "Waiting";
}

/** Reads one artifact whenever its key changes; the sheet's polling supplies new keys. */
function useArtifact<T>(
  source: TaskSource,
  key: string | undefined,
  parse: (text: string) => T,
): T | undefined {
  const [value, setValue] = React.useState<T>();
  const parser = React.useRef(parse);
  React.useEffect(() => {
    if (!key || !source.readArtifact) return;
    let stopped = false;
    void source
      .readArtifact(key)
      .then((text) => {
        if (!stopped) setValue(parser.current(text));
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [key, source]);
  return key ? value : undefined;
}
