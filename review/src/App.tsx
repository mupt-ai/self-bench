import { PatchDiff } from '@pierre/diffs/react';
import React from 'react';

import type { PromptOrigin, RunDetail, Summaries, TaskDetail, TaskSummary, Verdict } from './types';

type Tab = 'prompt' | 'task' | 'test' | 'gold' | 'validation' | 'runs';
type Filter = 'all' | Verdict;

const verdictOrder: Record<Verdict, number> = { accepted: 0, needs_review: 1, rejected: 2 };

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function App() {
  const [summaries, setSummaries] = React.useState<Summaries | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<TaskDetail | null>(null);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [search, setSearch] = React.useState('');
  const [tab, setTab] = React.useState<Tab>('prompt');
  const [error, setError] = React.useState<string | null>(null);

  const refreshSummaries = React.useCallback(async () => {
    const next = await getJson<Summaries>('/api/tasks');
    setSummaries(next);
    setSelected((current) => {
      if (current && next.tasks.some((task) => task.task_id === current)) return current;
      return (next.tasks.find((task) => task.verdict === 'accepted') ?? next.tasks[0])?.task_id ?? null;
    });
  }, []);

  React.useEffect(() => {
    refreshSummaries().catch((nextError: unknown) => setError(String(nextError)));
  }, [refreshSummaries]);

  React.useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    getJson<TaskDetail>(`/api/tasks/${encodeURIComponent(selected)}`)
      .then(setDetail)
      .catch((nextError: unknown) => setError(String(nextError)));
  }, [selected]);

  const refresh = React.useCallback(async () => {
    setError(null);
    await refreshSummaries();
    if (selected) setDetail(await getJson<TaskDetail>(`/api/tasks/${encodeURIComponent(selected)}`));
  }, [refreshSummaries, selected]);

  if (error) return <ErrorState error={error} onRetry={() => void refresh()} />;
  if (!summaries) return <div className="page-state">Loading tasks…</div>;

  const query = search.trim().toLowerCase();
  const visibleTasks = [...summaries.tasks]
    .sort((a, b) => verdictOrder[a.verdict] - verdictOrder[b.verdict] || a.task_id.localeCompare(b.task_id))
    .filter((task) => filter === 'all' || task.verdict === filter)
    .filter((task) => !query || `${task.task_id} ${task.workdir} ${task.source_pr ?? ''}`.toLowerCase().includes(query));

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">make-your-swebench</div>
          <h1>Task Review Console</h1>
        </div>
        <div className="meta topbar-actions">
          <span>Models: {summaries.models.join(' · ')}</span>
          <button className="brand-button" type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>
      <main className="main">
        <Sidebar
          summaries={summaries}
          tasks={visibleTasks}
          selected={selected}
          filter={filter}
          search={search}
          onFilter={setFilter}
          onSearch={setSearch}
          onSelect={(taskId) => { setSelected(taskId); setTab('prompt'); }}
        />
        <Detail
          detail={detail}
          tab={tab}
          onTab={setTab}
          onSaved={(nextDetail) => { setDetail(nextDetail); void refreshSummaries(); }}
        />
      </main>
    </div>
  );
}

function Sidebar({ summaries, tasks, selected, filter, search, onFilter, onSearch, onSelect }: {
  summaries: Summaries;
  tasks: TaskSummary[];
  selected: string | null;
  filter: Filter;
  search: string;
  onFilter: (value: Filter) => void;
  onSearch: (value: string) => void;
  onSelect: (taskId: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="filters">
        <div className="counts">
          <Count label="Accepted" value={summaries.counts.accepted ?? 0} />
          <Count label="Review" value={summaries.counts.needs_review ?? 0} />
          <Count label="Rejected" value={summaries.counts.rejected ?? 0} />
        </div>
        <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search task, workdir, PR" />
        <select value={filter} onChange={(event) => onFilter(event.target.value as Filter)}>
          <option value="all">All</option>
          <option value="accepted">Accepted</option>
          <option value="needs_review">Needs Review</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <div className="task-list">
        {tasks.length ? tasks.map((task) => (
          <button key={task.task_id} className="task-row" data-active={task.task_id === selected} type="button" onClick={() => onSelect(task.task_id)}>
            <div className="task-title">
              <span className="task-id">{task.task_id}</span>
              <Badge value={task.verdict} />
            </div>
            <div className="meta"><span>{task.workdir}</span><span>F2P {task.fail_to_pass_count}</span><span>P2P {task.pass_to_pass_count}</span></div>
            <div className="meta">{Object.entries(task.model_results).map(([model, result]) => <Badge key={model} value={`${shortModel(model)}: ${result}`} kind={result} />)}</div>
          </button>
        )) : <Empty>No tasks match this filter.</Empty>}
      </div>
    </aside>
  );
}

function Detail({ detail, tab, onTab, onSaved }: { detail: TaskDetail | null; tab: Tab; onTab: (tab: Tab) => void; onSaved: (detail: TaskDetail) => void }) {
  if (!detail) return <section className="content"><div className="detail"><Empty>Select a task.</Empty></div></section>;
  return (
    <section className="content">
      <div className="detail">
        <Summary summary={detail.summary} />
        <ReviewPanel key={detail.summary.task_id} detail={detail} onSaved={onSaved} />
        <section className="panel">
          <div className="tabs">
            {(['prompt', 'task', 'test', 'gold', 'validation', 'runs'] as Tab[]).map((value) => (
              <button key={value} className="tab" data-active={tab === value} type="button" onClick={() => onTab(value)}>{tabLabel(value)}</button>
            ))}
          </div>
          <div className="panel-body"><TabContent tab={tab} detail={detail} /></div>
        </section>
      </div>
    </section>
  );
}

function Summary({ summary }: { summary: TaskSummary }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div><div className="eyebrow">{summary.repo}</div><div className="panel-title">{summary.task_id}</div></div>
        <div className="meta"><Badge value={summary.verdict} /><Badge value={summary.validation} /></div>
      </div>
      <div className="panel-body">
        <div className="summary-grid">
          <Stat label="Workdir">{summary.workdir}</Stat>
          <Stat label="Source">{summary.source_url ? <a href={summary.source_url} target="_blank" rel="noreferrer">PR {summary.source_pr}</a> : (summary.source_pr ?? '—')}</Stat>
          <Stat label="Signal">{summary.solver_signal}</Stat>
          <Stat label="Tests">F2P {summary.fail_to_pass_count} / P2P {summary.pass_to_pass_count}</Stat>
        </div>
        {(summary.blockers.length > 0 || summary.warnings.length > 0) && <div className="warning-list issues">
          {summary.blockers.map((item) => <div key={item} className="warning blocker">{item}</div>)}
          {summary.warnings.map((item) => <div key={item} className="warning">{item}</div>)}
        </div>}
      </div>
    </section>
  );
}

function ReviewPanel({ detail, onSaved }: { detail: TaskDetail; onSaved: (detail: TaskDetail) => void }) {
  const [notes, setNotes] = React.useState(detail.summary.quality.review_notes ?? '');
  const [reviewed, setReviewed] = React.useState(() => new Set(detail.summary.quality.reviewed_warnings ?? []));
  const [saving, setSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    try {
      const next = await getJson<TaskDetail>(`/api/tasks/${encodeURIComponent(detail.summary.task_id)}/quality`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ review_notes: notes, reviewed_warnings: [...reviewed] }),
      });
      onSaved(next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div><div className="panel-title">Review Notes</div><div className="panel-hint">Writes to task.json quality metadata.</div></div>
        <button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save Review'}</button>
      </div>
      <div className="panel-body split">
        <div><div className="label">Reviewed Warnings</div><div className="field-body">
          {detail.summary.warnings.length ? detail.summary.warnings.map((warning) => (
            <label className="check-row" key={warning}>
              <input type="checkbox" checked={[...reviewed].some((token) => warning.includes(token))} onChange={(event) => setReviewed((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(warning); else next.delete(warning);
                return next;
              })} />
              <span>{warning}</span>
            </label>
          )) : <Empty>No active warnings.</Empty>}
        </div></div>
        <div><div className="label">Notes</div><textarea className="field-body" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Why this task is fair, what was manually checked, or why it should stay candidate-only." /></div>
      </div>
    </section>
  );
}

function TabContent({ tab, detail }: { tab: Tab; detail: TaskDetail }) {
  if (tab === 'prompt') return <PromptView prompt={detail.prompt} origin={detail.prompt_origin} />;
  if (tab === 'task') return <Code>{detail.task_json_text}</Code>;
  if (tab === 'test') return <DiffViewer taskId={detail.summary.task_id} kind="test" label="Test Patch" />;
  if (tab === 'gold') return <DiffViewer taskId={detail.summary.task_id} kind="gold" label="Gold Patch" />;
  if (tab === 'validation') return <Validation detail={detail} />;
  return <Runs detail={detail} />;
}

function PromptView({ prompt, origin }: { prompt: string; origin: PromptOrigin }) {
  const source = origin.kind === 'agent_json' ? `${origin.format} · ${origin.path} · message ${origin.message_index}` : origin.path;
  return <div><div className="source-line"><span className="label">Prompt Source</span><span className="subtle">{source}</span></div><Code>{prompt}</Code></div>;
}

function DiffViewer({ taskId, kind, label, modelSlug, compact = false }: { taskId: string; kind: 'test' | 'gold' | 'agent'; label: string; modelSlug?: string; compact?: boolean }) {
  const [patch, setPatch] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const path = modelSlug
    ? `/api/tasks/${encodeURIComponent(taskId)}/patch/${kind}/${encodeURIComponent(modelSlug)}`
    : `/api/tasks/${encodeURIComponent(taskId)}/patch/${kind}`;

  React.useEffect(() => {
    const controller = new AbortController();
    fetch(path, { signal: controller.signal, cache: 'no-store' })
      .then((response) => { if (!response.ok) throw new Error(`Patch fetch failed: ${response.status}`); return response.text(); })
      .then(setPatch)
      .catch((nextError: unknown) => { if (!controller.signal.aborted) setError(String(nextError)); });
    return () => controller.abort();
  }, [path]);

  return <div className={`diff-shell${expanded ? ' expanded' : ''}${compact ? ' compact' : ''}`}>
    <div className="diff-toolbar"><span className="label">{label}</span><div className="meta"><button className="link-button" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Close full screen' : 'Open full screen'}</button><a href={path} target="_blank" rel="noreferrer">Raw patch</a></div></div>
    <div className="diff-body">
      {error ? <div className="warning blocker">{error}</div> : patch ? <PatchDiff patch={patch} disableWorkerPool options={{ themeType: 'dark', diffStyle: window.matchMedia('(max-width: 900px)').matches ? 'unified' : 'split', diffIndicators: 'bars', overflow: 'scroll', disableBackground: false, disableLineNumbers: false, stickyHeader: true, lineHoverHighlight: 'number' }} /> : <Empty>Loading patch…</Empty>}
    </div>
  </div>;
}

function Validation({ detail }: { detail: TaskDetail }) {
  if (!detail.validation_result) return <Empty>No validation artifact found.</Empty>;
  const result = detail.validation_result;
  return <div className="split"><Code>{detail.validation_text}</Code><div className="warning-list">
    <Tail title="Base F2P Tail" value={result.base_f2p_tail} /><Tail title="Base P2P Tail" value={result.base_p2p_tail} /><Tail title="Gold F2P Tail" value={result.gold_f2p_tail} /><Tail title="Gold P2P Tail" value={result.gold_p2p_tail} />
  </div></div>;
}

function Runs({ detail }: { detail: TaskDetail }) {
  return <>{Object.entries(detail.runs).map(([slug, run]) => <Run key={slug} taskId={detail.summary.task_id} slug={slug} run={run} />)}</>;
}

function Run({ taskId, slug, run }: { taskId: string; slug: string; run: RunDetail }) {
  if (!run.exists) return <div className="run-card"><div className="run-head"><span>{slug}</span><Badge value="missing" /></div></div>;
  const result = run.result ?? {};
  const resolved = result.resolved === true;
  const reasons = Array.isArray(result.failure_reasons) ? result.failure_reasons.join('\n') : '';
  return <div className="run-card">
    <div className="run-head"><span>{slug}</span><Badge value={resolved ? 'resolved' : 'failed'} kind={resolved ? 'pass' : 'fail'} /></div>
    <div className="run-body"><div className="warning-list"><Tail title="Failure Reasons" value={reasons} /><Tail title="F2P Tail" value={result.f2p_tail} /><Tail title="P2P Tail" value={result.p2p_tail} /><Tail title="Agent Log Tail" value={result.agent_log_tail} /></div><div>{run.agent_patch ? <DiffViewer taskId={taskId} kind="agent" label="Agent Patch" modelSlug={slug} compact /> : <Code>{run.result_text}</Code>}</div></div>
  </div>;
}

function Tail({ title, value }: { title: string; value: unknown }) {
  if (typeof value !== 'string' || !value) return null;
  return <div><div className="label tail-title">{title}</div><Code>{value}</Code></div>;
}

function Count({ label, value }: { label: string; value: number }) { return <div className="count"><div className="label">{label}</div><div className="value">{value}</div></div>; }
function Badge({ value, kind }: { value: string; kind?: string }) { return <span className={`badge ${kind ?? value}`}>{value}</span>; }
function Stat({ label, children }: React.PropsWithChildren<{ label: string }>) { return <div className="stat"><div className="label">{label}</div><div className="stat-value">{children}</div></div>; }
function Code({ children }: { children: string }) { return <pre className="code">{children}</pre>; }
function Empty({ children }: React.PropsWithChildren) { return <div className="empty">{children}</div>; }
function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) { return <div className="page-state"><div className="warning blocker">{error}</div><button type="button" onClick={onRetry}>Retry</button></div>; }
function tabLabel(tab: Tab) { return ({ prompt: 'Prompt', task: 'Task JSON', test: 'Test Patch', gold: 'Gold Patch', validation: 'Validation', runs: 'Runs' })[tab]; }
function shortModel(slug: string) { return slug.replace('openai__', 'openai ').replace('fireworks__', 'fw '); }
