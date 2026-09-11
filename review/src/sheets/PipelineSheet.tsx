import React from "react";
import { Block } from "../components/Script";
import {
  loading,
  notice,
  prose,
  sheetBody,
  sheetTable,
  tableCode,
  tableColumn,
  viewerLink,
} from "../components/viewer-ui";
import { formatBytes, formatTime } from "../lib/format";
import {
  type ArtifactSummary,
  MAX_SUMMARY_BYTES,
  summarizeArtifact,
  summarizeLogTail,
} from "../lib/summaries";

const LOG_TAIL_BYTES = 12 * 1024;

import type { TaskSource } from "../sources/types";
import type { ArtifactEntry, ArtifactGroup, CandidateArtifacts, TaskRow } from "../types";

const GROUPS: [ArtifactGroup, string][] = [
  ["provenance", "Provenance · The Human Request"],
  ["authoring", "Authoring · Definition and Source Bundle"],
  ["environments", "Environment Authoring · Compiled Bundles"],
  ["audits", "Audit · Static Gates"],
  ["environment-preflights", "Preflight · Smoke and nop in the Built Image"],
  ["validation", "Validation · Harbor nop and oracle"],
  ["validation-repairs", "Validation Repair"],
  ["verification", "Verification"],
  ["verify", "Worker Verify"],
  ["reviews", "Coupling Review"],
  ["repairs", "Review Repair"],
];

export function PipelineSheet({
  source,
  row,
  artifacts,
  onOpenArtifact,
  onOpenBundle,
}: {
  source: TaskSource;
  row: TaskRow;
  artifacts: CandidateArtifacts | null;
  onOpenArtifact: (key: string, sizeBytes: number) => void;
  onOpenBundle: (key: string) => void;
}) {
  const [summaries, setSummaries] = React.useState<Map<string, ArtifactSummary>>(new Map());
  React.useEffect(() => {
    if (!artifacts || !source.readArtifact) return;
    let cancelled = false;
    const wanted: [ArtifactGroup, ArtifactEntry][] = [];
    for (const [group] of GROUPS) {
      for (const entry of artifacts.groups[group] ?? []) {
        const isJson = entry.key.endsWith(".json") && entry.sizeBytes <= MAX_SUMMARY_BYTES;
        const isLog = entry.key.endsWith(".log") && entry.sizeBytes > 0;
        if (isJson || isLog) wanted.push([group, entry]);
      }
    }
    const read = source.readArtifact;
    void Promise.all(
      wanted.slice(0, 60).map(async ([group, entry]) => {
        try {
          if (entry.key.endsWith(".log")) {
            const start = Math.max(0, entry.sizeBytes - LOG_TAIL_BYTES);
            const tail = await read(entry.key, start > 0 ? { start } : undefined);
            return [entry.key, summarizeLogTail(tail)] as const;
          }
          const body = await read(entry.key);
          return [entry.key, summarizeArtifact(group, entry.key, body)] as const;
        } catch (error) {
          return [entry.key, { text: `unreadable: ${String(error)}`, tone: "warn" }] as const;
        }
      }),
    ).then((results) => {
      if (!cancelled) setSummaries(new Map(results));
    });
    return () => {
      cancelled = true;
    };
  }, [artifacts, source]);

  if (!artifacts) return <p className={loading}>listing pipeline artifacts</p>;
  const total = Object.values(artifacts.groups).reduce((sum, list) => sum + list.length, 0);
  return (
    <div className={sheetBody}>
      {row.reason && (
        <Block title="Final Reason" detail={row.stage ?? row.status}>
          <pre className={prose}>{row.reason}</pre>
        </Block>
      )}
      {total === 0 && (
        <p className={`${notice} site:p-0!`}>No artifacts recorded for this candidate.</p>
      )}
      {GROUPS.map(([group, title]) => {
        const entries = artifacts.groups[group] ?? [];
        if (entries.length === 0) return null;
        return (
          <Block key={group} title={title} detail={`${entries.length}`}>
            <table className={sheetTable}>
              <thead>
                <tr>
                  <th className={tableColumn}>Artifact</th>
                  <th className={tableColumn}>Size</th>
                  <th className={tableColumn}>Written</th>
                  <th className={tableColumn}>What It Says</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const summary = summaries.get(entry.key);
                  const bundle = entry.key.endsWith(".tar.gz");
                  const tail = entry.key.replace(`runs/${artifacts.runId}/${group}/`, "");
                  return (
                    <tr key={entry.key}>
                      <td className={tableCode}>
                        <button
                          type="button"
                          className={viewerLink}
                          onClick={() =>
                            bundle
                              ? onOpenBundle(entry.key)
                              : onOpenArtifact(entry.key, entry.sizeBytes)
                          }
                        >
                          {tail}
                        </button>
                      </td>
                      <td className="!text-right whitespace-nowrap tabular-nums site:!font-mono text-(--muted-fg) site:text-muted-foreground">
                        {formatBytes(entry.sizeBytes)}
                      </td>
                      <td className="whitespace-nowrap site:!font-mono text-(--muted-fg) site:text-muted-foreground">
                        {formatTime(entry.updatedAt)}
                      </td>
                      <td
                        className={`${tableCode} ${({ ok: "!text-(--ok) site:!text-brand", bad: "!text-(--bad-fg) site:!text-destructive", warn: "!text-(--warn-fg) site:!text-warning" })[summary?.tone as "ok" | "bad" | "warn"] ?? ""}`}
                      >
                        {bundle ? (
                          <span className="text-(--muted-fg) site:text-muted-foreground">
                            bundle · click to load its files
                          </span>
                        ) : (
                          (summary?.text ?? "")
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Block>
        );
      })}
    </div>
  );
}
