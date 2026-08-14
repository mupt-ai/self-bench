import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, CircleDollarSign, Clock3, GitCompareArrows, Search, Sparkles, X } from "lucide-react";
import { format, runMetrics, taskLabel, taskMap } from "../lib/metrics";
import type { Evaluation, EvalRun, TaskResult } from "../lib/types";

export function EvaluationView({ evaluation }: { evaluation: Evaluation }) {
  const [selectedRunID, setSelectedRunID] = useState(evaluation.runs[0]?.id ?? "");
  const [compareRunID, setCompareRunID] = useState(evaluation.runs[1]?.id ?? evaluation.runs[0]?.id ?? "");
  const [taskQuery, setTaskQuery] = useState("");
  const [taskFilter, setTaskFilter] = useState<"all" | "passed" | "failed" | "flips">("all");
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const taskSurfaceRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setSelectedRunID(evaluation.runs[0]?.id ?? "");
    setCompareRunID(evaluation.runs[1]?.id ?? evaluation.runs[0]?.id ?? "");
    setTaskQuery("");
    setTaskFilter("all");
    setSelectedTask(null);
  }, [evaluation.id, evaluation.runs]);

  const metrics = useMemo(() => new Map(evaluation.runs.map((run) => [run.id, runMetrics(run)])), [evaluation]);
  const selectedRun = evaluation.runs.find((run) => run.id === selectedRunID) ?? evaluation.runs[0];
  const compareRun = evaluation.runs.find((run) => run.id === compareRunID) ?? evaluation.runs[1] ?? selectedRun;
  const selectedMetrics = selectedRun ? metrics.get(selectedRun.id) : undefined;
  const totalTasks = new Set(evaluation.runs.flatMap((run) => run.results.map((result) => result.task_id))).size;
  const totalCost = [...metrics.values()].reduce((sum, value) => sum + value.totalCost, 0);
  const averageCost = evaluation.runs.length ? totalCost / evaluation.runs.length : 0;
  const bestRun = [...evaluation.runs].sort((left, right) => (metrics.get(right.id)?.score ?? 0) - (metrics.get(left.id)?.score ?? 0))[0];
  const bestMetrics = bestRun ? metrics.get(bestRun.id) : undefined;
  const ranked = [...evaluation.runs].sort((left, right) => (metrics.get(right.id)?.score ?? 0) - (metrics.get(left.id)?.score ?? 0));
  const selectedRank = selectedRun ? ranked.findIndex((run) => run.id === selectedRun.id) + 1 : 0;

  const allTasks = useMemo(() => {
    const tasks = new Map<string, TaskResult>();
    for (const run of evaluation.runs) for (const result of run.results) if (!tasks.has(result.task_id)) tasks.set(result.task_id, result);
    return [...tasks.values()];
  }, [evaluation]);
  const selectedResults = selectedRun ? taskMap(selectedRun) : new Map<string, TaskResult>();
  const compareResults = compareRun ? taskMap(compareRun) : new Map<string, TaskResult>();
  const visibleTasks = allTasks.filter((task) => {
    const left = selectedResults.get(task.task_id);
    const right = compareResults.get(task.task_id);
    const matchesQuery = `${task.task_id} ${task.task_name}`.toLowerCase().includes(taskQuery.toLowerCase());
    if (!matchesQuery) return false;
    if (taskFilter === "passed") return Boolean(left?.passed);
    if (taskFilter === "failed") return left ? !left.passed : false;
    if (taskFilter === "flips") {
      if (!left || !right) return false;
      return left.passed !== right.passed;
    }
    return true;
  });

  return (
    <div className="evaluation-page">
      <header className="page-header">
        <div>
          <div className="breadcrumbs"><span>Evaluations</span><ChevronRight size={12} /><span>{evaluation.benchmark}</span></div>
          <div className="title-line"><h1>{evaluation.name}</h1><span className="status-pill"><i /> Complete</span></div>
          <p>{evaluation.description || `${evaluation.runs.length} model configurations evaluated on ${evaluation.benchmark}.`}</p>
        </div>
      </header>

      <div className="meta-strip">
        <span><small>Benchmark</small><strong>{evaluation.benchmark}</strong></span>
        <span><small>Uploaded</small><strong>{format.date(evaluation.uploaded_at)}</strong></span>
        <span><small>Source</small><strong>{evaluation.source_file || "JSON upload"}</strong></span>
        <span><small>Coverage</small><strong>{evaluation.runs.length} runs × {totalTasks} tasks</strong></span>
      </div>

      <section className="kpi-grid">
        <Metric label="Best score" value={format.percent(bestMetrics?.score ?? 0)} detail={bestRun?.name ?? "—"} accent />
        <Metric label="Tasks evaluated" value={String(totalTasks)} detail={`${evaluation.runs.length} configurations`} />
        <Metric label="Total spend" value={format.dollars(totalCost)} detail={`${format.dollars(averageCost)} average / run`} />
        <Metric label="Best cost / task" value={format.dollars(Math.min(...[...metrics.values()].map((item) => item.costPerTask)))} detail="Across all configurations" />
      </section>

      <section className="analysis-grid">
        <article className="surface pareto-surface">
          <SurfaceHeading eyebrow="Cost × performance" title="Run frontier"><span className="legend"><i /> Selected <i /> Pareto-efficient</span></SurfaceHeading>
          <ParetoChart runs={evaluation.runs} selectedID={selectedRun?.id ?? ""} onSelect={setSelectedRunID} />
        </article>
        <article className="surface selected-run-card">
          {selectedRun && selectedMetrics ? <RunDossier run={selectedRun} metrics={selectedMetrics} rank={selectedRank} /> : null}
        </article>
      </section>

      <section className="surface ledger-surface">
        <SurfaceHeading eyebrow="Configuration ledger" title="Every run"><button className="quiet-button" type="button" onClick={() => { setTaskFilter("flips"); taskSurfaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}><GitCompareArrows size={14} /> Compare selected</button></SurfaceHeading>
        <div className="run-ledger" role="table" aria-label="Evaluation runs">
          <div className="ledger-row ledger-head" role="row"><span>Run / model</span><span>Provider</span><span>Harness</span><span>Thinking</span><span>Score</span><span>Cost / task</span><span>Total</span></div>
          {ranked.map((run, index) => {
            const runStats = metrics.get(run.id)!;
            return (
              <button key={run.id} type="button" className={`ledger-row ${run.id === selectedRun?.id ? "selected" : ""}`} onClick={() => setSelectedRunID(run.id)}>
                <span className="run-identity"><b>{index + 1}</b><span><strong>{run.name}</strong><small>{run.model}</small></span></span>
                <span><em>{run.provider}</em></span><span>{run.harness}</span><span><code>{run.thinking_level}</code></span>
                <span className="score-cell"><strong>{format.percent(runStats.score)}</strong><i><b style={{ width: `${runStats.score * 100}%` }} /></i></span>
                <span>{format.dollars(runStats.costPerTask)}</span><span>{format.dollars(runStats.totalCost)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="surface task-surface" ref={taskSurfaceRef}>
        <SurfaceHeading eyebrow="Task evidence" title="Result explorer"><span>{visibleTasks.length} of {allTasks.length} tasks</span></SurfaceHeading>
        <div className="task-toolbar">
          <label><Search size={14} /><input value={taskQuery} onChange={(event) => setTaskQuery(event.target.value)} placeholder="Search task name or ID" /></label>
          <div className="segmented" role="group" aria-label="Filter tasks">
            {(["all", "passed", "failed", "flips"] as const).map((filter) => <button key={filter} className={taskFilter === filter ? "active" : ""} type="button" onClick={() => setTaskFilter(filter)}>{filter}</button>)}
          </div>
          <div className="run-selectors">
            <RunSelect value={selectedRun?.id ?? ""} runs={evaluation.runs} onChange={setSelectedRunID} />
            <span>vs</span>
            <RunSelect value={compareRun?.id ?? ""} runs={evaluation.runs} onChange={setCompareRunID} />
          </div>
        </div>
        <div className="task-table">
          <div className="task-row task-head"><span>Task</span><span>{selectedRun?.name}</span><span>{compareRun?.name}</span><span>Cost delta</span><span /></div>
          {visibleTasks.map((task) => {
            const left = selectedResults.get(task.task_id);
            const right = compareResults.get(task.task_id);
            const comparable = Boolean(left && right);
            const delta = comparable ? (left!.cost_usd - right!.cost_usd) : 0;
            return (
              <button key={task.task_id} type="button" className="task-row" onClick={() => setSelectedTask(task.task_id)}>
                <span><strong>{taskLabel(task)}</strong><small>{task.task_id}</small></span>
                <ResultCell result={left} /><ResultCell result={right} />
                <span className={comparable ? (delta <= 0 ? "good-delta" : "bad-delta") : "missing-result"}>{comparable ? signedMoney(delta) : "Not comparable"}</span>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </div>
      </section>

      {selectedTask && selectedRun && compareRun ? (
        <TaskDrawer taskID={selectedTask} primary={selectedRun} comparison={compareRun} onClose={() => setSelectedTask(null)} />
      ) : null}
    </div>
  );
}

function Metric({ label, value, detail, accent }: { label: string; value: string; detail: string; accent?: boolean }) {
  return <article className={`kpi ${accent ? "accent" : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function SurfaceHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <header className="surface-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><div>{children}</div></header>;
}

function ParetoChart({ runs, selectedID, onSelect }: { runs: EvalRun[]; selectedID: string; onSelect: (id: string) => void }) {
  const points = runs.map((run) => ({ run, metrics: runMetrics(run) }));
  const maxCost = Math.max(...points.map(({ metrics }) => metrics.costPerTask), 0.01) * 1.18;
  const efficient = new Set(points.filter((candidate) => !points.some((other) => other.run.id !== candidate.run.id && other.metrics.score >= candidate.metrics.score && other.metrics.costPerTask <= candidate.metrics.costPerTask && (other.metrics.score > candidate.metrics.score || other.metrics.costPerTask < candidate.metrics.costPerTask))).map(({ run }) => run.id));
  const frontier = points.filter(({ run }) => efficient.has(run.id)).sort((left, right) => left.metrics.costPerTask - right.metrics.costPerTask);
  const x = (cost: number) => 54 + (cost / maxCost) * 520;
  const y = (score: number) => 250 - score * 205;
  return (
    <div className="pareto-chart">
      <svg viewBox="0 0 620 290" role="img" aria-label="Accuracy by cost per task">
        {[0.25, 0.5, 0.75, 1].map((value) => <g key={value}><line x1="54" x2="584" y1={y(value)} y2={y(value)} /><text x="43" y={y(value) + 4}>{format.percent(value)}</text></g>)}
        {[0, 0.25, 0.5, 0.75, 1].map((value) => <text key={value} x={54 + value * 520} y="278" textAnchor="middle">{format.dollars(value * maxCost)}</text>)}
        {frontier.length > 1 && <polyline className="frontier" points={frontier.map(({ metrics }) => `${x(metrics.costPerTask)},${y(metrics.score)}`).join(" ")} />}
        {points.map(({ run, metrics }) => (
          <g key={run.id} className={`chart-point ${selectedID === run.id ? "selected" : ""} ${efficient.has(run.id) ? "efficient" : ""}`} role="button" tabIndex={0} onClick={() => onSelect(run.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(run.id); }}>
            <circle cx={x(metrics.costPerTask)} cy={y(metrics.score)} r={selectedID === run.id ? 8 : 5} />
            <text x={x(metrics.costPerTask)} y={y(metrics.score) - 13} textAnchor="middle">{run.name}</text>
          </g>
        ))}
      </svg>
      <span className="axis-label y">Average score</span><span className="axis-label x">Cost per task →</span>
    </div>
  );
}

function RunDossier({ run, metrics, rank }: { run: EvalRun; metrics: ReturnType<typeof runMetrics>; rank: number }) {
  return <div className="dossier"><header><div><p className="eyebrow">Selected run</p><h2>{run.name}</h2><span>{run.model}</span></div><span className="rank-badge">#{rank}</span></header><div className="dossier-score"><strong>{format.percent(metrics.score)}</strong><span>average score</span></div><div className="dossier-grid"><span><small>Provider</small><b>{run.provider}</b></span><span><small>Harness</small><b>{run.harness}</b></span><span><small>Thinking</small><b>{run.thinking_level}</b></span><span><small>Pass rate</small><b>{format.percent(metrics.passRate)}</b></span></div><div className="dossier-cost"><span><CircleDollarSign size={14} /> Total cost <b>{format.dollars(metrics.totalCost)}</b></span><span><Clock3 size={14} /> Runtime <b>{format.duration(metrics.durationMS)}</b></span></div><div className="token-meter"><span><small>Input</small>{format.number(metrics.inputTokens)} tokens</span><span><small>Output</small>{format.number(metrics.outputTokens)} tokens</span></div></div>;
}

function RunSelect({ value, runs, onChange }: { value: string; runs: EvalRun[]; onChange: (id: string) => void }) {
  return <label className="run-select"><select value={value} onChange={(event) => onChange(event.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>{run.name}</option>)}</select><ChevronDown size={12} /></label>;
}

function ResultCell({ result }: { result?: TaskResult }) {
  if (!result) return <span className="missing-result">Not run</span>;
  return <span className={`result-cell ${result.passed ? "pass" : "fail"}`}><i>{result.passed ? <Check size={10} /> : <X size={10} />}</i><strong>{format.percent(result.score)}</strong><small>{format.dollars(result.cost_usd)}</small></span>;
}

function TaskDrawer({ taskID, primary, comparison, onClose }: { taskID: string; primary: EvalRun; comparison: EvalRun; onClose: () => void }) {
  const first = taskMap(primary).get(taskID);
  const second = taskMap(comparison).get(taskID);
  const reference = first ?? second;
  if (!reference) return null;
  const comparable = Boolean(first && second);
  return <><button className="drawer-scrim" type="button" aria-label="Close task detail" onClick={onClose} /><aside className="task-drawer"><header><div><p className="eyebrow">Task evidence</p><h2>{taskLabel(reference)}</h2><code>{taskID}</code></div><button type="button" onClick={onClose}><X size={17} /></button></header><section className="drawer-comparison"><DrawerRun run={primary} result={first} /><div className="versus">vs</div><DrawerRun run={comparison} result={second} /></section><section className="drawer-section"><h3>Execution detail</h3><div className="execution-grid"><span><small>Cost difference</small><strong>{comparable ? signedMoney(first!.cost_usd - second!.cost_usd) : "Not comparable"}</strong></span><span><small>Runtime difference</small><strong>{comparable ? format.duration(Math.abs((first!.duration_ms ?? 0) - (second!.duration_ms ?? 0))) : "Not comparable"}</strong></span><span><small>Score movement</small><strong>{comparable ? signedPercent(first!.score - second!.score) : "Not comparable"}</strong></span></div></section>{first?.error || second?.error ? <section className="drawer-section"><h3>Failure evidence</h3>{first?.error && <div className="error-log"><small>{primary.name}</small><code>{first.error}</code></div>}{second?.error && <div className="error-log"><small>{comparison.name}</small><code>{second.error}</code></div>}</section> : <section className="drawer-success"><Sparkles size={16} /><div><strong>No reported errors</strong><p>Both result artifacts completed without a captured error.</p></div></section>}</aside></>;
}

function DrawerRun({ run, result }: { run: EvalRun; result?: TaskResult }) {
  return <article><div className="drawer-run-head"><span><strong>{run.name}</strong><small>{run.model}</small></span>{result ? <i className={result.passed ? "pass" : "fail"}>{result.passed ? "Passed" : "Failed"}</i> : <i>Missing</i>}</div>{result ? <><strong className="drawer-score">{format.percent(result.score)}</strong><dl><div><dt>Cost</dt><dd>{format.dollars(result.cost_usd)}</dd></div><div><dt>Runtime</dt><dd>{format.duration(result.duration_ms ?? 0)}</dd></div><div><dt>Tokens</dt><dd>{format.number((result.input_tokens ?? 0) + (result.output_tokens ?? 0))}</dd></div></dl></> : <p>Not present in this run.</p>}</article>;
}

function signedMoney(value: number) { return `${value > 0 ? "+" : value < 0 ? "−" : ""}${format.dollars(Math.abs(value))}`; }
function signedPercent(value: number) { return `${value > 0 ? "+" : value < 0 ? "−" : ""}${format.percent(Math.abs(value))}`; }
