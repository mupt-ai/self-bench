import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import React from "react";
import { loadGuardedTaskDetail } from "./detail-loader";
import type {
  ModelResult,
  PromptOrigin,
  ReviewStatus,
  RunDetail,
  SourceTrace,
  Summaries,
  TaskDetail,
  TaskSummary,
} from "./types";

type Section = "brief" | "tests" | "gold" | "validation" | "runs" | "task";
type QueueFilter = "all" | "attention" | "approved";
type PatchKind = "test" | "gold" | "agent";
type Theme = "light" | "dark";

const ThemeContext = React.createContext<Theme>("light");

const sections: ReadonlyArray<{ id: Section; label: string }> = [
  { id: "brief", label: "Brief" },
  { id: "tests", label: "Tests" },
  { id: "gold", label: "Reference" },
  { id: "validation", label: "Validation" },
  { id: "runs", label: "Model runs" },
  { id: "task", label: "Task config" },
];

const reviewStatuses: ReviewStatus[] = [
  "unreviewed",
  "in_review",
  "approved",
  "changes_requested",
  "rejected",
];

const diffSkeletonWidths = [48, 65, 82, 55, 72, 89, 62, 79, 52, 69, 86, 59];

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function App() {
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const [summaries, setSummaries] = React.useState<Summaries | null>(null);
  const [selected, setSelected] = React.useState<string | null>(() => params.get("task"));
  const [detail, setDetail] = React.useState<TaskDetail | null>(null);
  const [section, setSection] = React.useState<Section>(() => sectionFrom(params.get("tab")));
  const [filter, setFilter] = React.useState<QueueFilter>("all");
  const [search, setSearch] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [theme, setTheme] = React.useState<Theme>(initialTheme);
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;

  const fetchDetail = React.useCallback(
    (taskId: string, signal: AbortSignal) =>
      getJson<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`, { signal }),
    [],
  );

  const refreshSummaries = React.useCallback(async () => {
    const next = await getJson<Summaries>("/api/tasks");
    setSummaries(next);
    setSelected((current) => {
      if (current && next.tasks.some((task) => task.task_id === current)) {
        return current;
      }
      return next.tasks[0]?.task_id ?? null;
    });
  }, []);

  React.useEffect(() => {
    refreshSummaries().catch((nextError: unknown) => setError(String(nextError)));
  }, [refreshSummaries]);

  React.useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("selfbench-theme", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0d1016" : "#f4f5f7");
  }, [theme]);

  React.useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    loadGuardedTaskDetail(
      selected,
      controller.signal,
      (taskId) => selectedRef.current === taskId,
      fetchDetail,
      setDetail,
    ).catch((nextError: unknown) => {
      if (!controller.signal.aborted) setError(String(nextError));
    });
    return () => controller.abort();
  }, [fetchDetail, selected]);

  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (selected) url.searchParams.set("task", selected);
    else url.searchParams.delete("task");
    url.searchParams.set("tab", section);
    window.history.replaceState(null, "", url);
  }, [section, selected]);

  const visibleTasks = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return (summaries?.tasks ?? [])
      .filter((task) => {
        if (filter === "approved") return task.review_status === "approved";
        if (filter === "attention") {
          return (
            task.review_status !== "approved" || Object.values(task.model_results).includes("fail")
          );
        }
        return true;
      })
      .filter((task) =>
        query
          ? `${task.task_id} ${task.repo} ${task.source_pr ?? ""}`.toLowerCase().includes(query)
          : true,
      );
  }, [filter, search, summaries]);

  React.useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (isEditing(event.target) || (event.key !== "j" && event.key !== "k")) return;
      const index = visibleTasks.findIndex((task) => task.task_id === selected);
      const nextIndex = Math.min(
        Math.max(index + (event.key === "j" ? 1 : -1), 0),
        visibleTasks.length - 1,
      );
      const next = visibleTasks[nextIndex];
      if (next) setSelected(next.task_id);
    };
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [selected, visibleTasks]);

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const taskId = selectedRef.current;
    const controller = new AbortController();
    try {
      await refreshSummaries();
      if (taskId && selectedRef.current === taskId) {
        await loadGuardedTaskDetail(
          taskId,
          controller.signal,
          (candidate) => selectedRef.current === candidate,
          fetchDetail,
          setDetail,
        );
      }
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      controller.abort();
      setRefreshing(false);
    }
  }, [fetchDetail, refreshSummaries]);

  if (error) {
    return (
      <ThemeContext.Provider value={theme}>
        <ErrorState error={error} onRetry={() => void refresh()} />
      </ThemeContext.Provider>
    );
  }
  if (!summaries) {
    return (
      <ThemeContext.Provider value={theme}>
        <LoadingState />
      </ThemeContext.Provider>
    );
  }

  const selectedIndex = visibleTasks.findIndex((task) => task.task_id === selected);
  const previousTask = selectedIndex > 0 ? visibleTasks[selectedIndex - 1]?.task_id : null;
  const nextTask = selectedIndex >= 0 ? visibleTasks[selectedIndex + 1]?.task_id : null;

  return (
    <ThemeContext.Provider value={theme}>
      <div className="app-shell">
        <Header
          summaries={summaries}
          refreshing={refreshing}
          theme={theme}
          onRefresh={() => void refresh()}
          onTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        />
        <div className="app-grid">
          <TaskQueue
            filter={filter}
            models={summaries.models}
            onFilter={setFilter}
            onSearch={setSearch}
            onSelect={(taskId) => {
              setSelected(taskId);
              setSection("brief");
            }}
            search={search}
            selected={selected}
            tasks={visibleTasks}
            total={summaries.tasks.length}
          />
          <main className="workspace">
            {detail ? (
              <TaskWorkspace
                detail={detail}
                models={summaries.models}
                nextTask={nextTask ?? null}
                onNavigate={setSelected}
                onSaved={(nextDetail) => {
                  setDetail((current) =>
                    current?.summary.task_id === nextDetail.summary.task_id ? nextDetail : current,
                  );
                  void refreshSummaries();
                }}
                onSection={setSection}
                previousTask={previousTask ?? null}
                section={section}
              />
            ) : (
              <WorkspaceSkeleton />
            )}
          </main>
        </div>
      </div>
    </ThemeContext.Provider>
  );
}

function Header({
  summaries,
  refreshing,
  theme,
  onRefresh,
  onTheme,
}: {
  summaries: Summaries;
  refreshing: boolean;
  theme: Theme;
  onRefresh: () => void;
  onTheme: () => void;
}) {
  const complete = summaries.tasks.flatMap((task) => Object.values(task.model_results));
  const pending = complete.filter((result) => result === "missing").length;
  return (
    <header className="site-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          S
        </div>
        <div>
          <div className="brand-name">SelfBench</div>
          <div className="brand-context">Evaluation review</div>
        </div>
      </div>
      <div className="header-status">
        <span className="live-dot" data-active={pending > 0} />
        <span>{pending > 0 ? `${pending} runs in progress` : "All results synchronized"}</span>
      </div>
      <div className="header-actions">
        <div className="keyboard-hint" title="Keyboard shortcut">
          <kbd>J</kbd>
          <kbd>K</kbd>
          <span>navigate</span>
        </div>
        <button
          className="button secondary theme-toggle"
          type="button"
          aria-label={`Use ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Use ${theme === "dark" ? "light" : "dark"} mode`}
          onClick={onTheme}
        >
          <ThemeIcon theme={theme} />
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshIcon spinning={refreshing} />
          {refreshing ? "Refreshing" : "Refresh"}
        </button>
      </div>
    </header>
  );
}

function TaskQueue({
  tasks,
  total,
  selected,
  models,
  search,
  filter,
  onSearch,
  onFilter,
  onSelect,
}: {
  tasks: TaskSummary[];
  total: number;
  selected: string | null;
  models: string[];
  search: string;
  filter: QueueFilter;
  onSearch: (value: string) => void;
  onFilter: (value: QueueFilter) => void;
  onSelect: (taskId: string) => void;
}) {
  return (
    <aside className="queue">
      <div className="queue-head">
        <div className="queue-title-row">
          <div>
            <div className="eyebrow">Review queue</div>
            <h1>{total} tasks</h1>
          </div>
          <div className="model-legend">
            {models.map((model) => (
              <span key={model}>{modelInitial(model)}</span>
            ))}
          </div>
        </div>
        <label className="search-field">
          <SearchIcon />
          <input
            aria-label="Search tasks"
            placeholder="Search tasks or PRs"
            type="search"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <nav className="filter-tabs" aria-label="Queue filter">
          {(["all", "attention", "approved"] as const).map((value) => (
            <button
              key={value}
              type="button"
              data-active={filter === value}
              onClick={() => onFilter(value)}
            >
              {humanize(value)}
            </button>
          ))}
        </nav>
      </div>
      <div className="task-list">
        {tasks.length ? (
          tasks.map((task) => (
            <TaskRow
              key={task.task_id}
              active={task.task_id === selected}
              models={models}
              onSelect={() => onSelect(task.task_id)}
              task={task}
            />
          ))
        ) : (
          <EmptyState
            title="No matching tasks"
            body="Try a broader search or a different filter."
          />
        )}
      </div>
    </aside>
  );
}

function TaskRow({
  task,
  models,
  active,
  onSelect,
}: {
  task: TaskSummary;
  models: string[];
  active: boolean;
  onSelect: () => void;
}) {
  const passCount = Object.values(task.model_results).filter((result) => result === "pass").length;
  const completeCount = Object.values(task.model_results).filter((result) =>
    ["pass", "fail", "unreadable"].includes(result),
  ).length;
  return (
    <button className="task-row" type="button" data-active={active} onClick={onSelect}>
      <div className="task-row-top">
        <span className="task-name">{taskLabel(task.task_id)}</span>
        <span className="task-score">
          {passCount}/{completeCount || models.length}
        </span>
      </div>
      <div className="task-id">{task.task_id}</div>
      <div className="task-row-bottom">
        <span>PR {task.source_pr ?? "—"}</span>
        <div className="result-dots">
          {models.map((model) => (
            <ResultDot key={model} label={modelInitial(model)} result={task.model_results[model]} />
          ))}
        </div>
      </div>
    </button>
  );
}

function TaskWorkspace({
  detail,
  models,
  section,
  previousTask,
  nextTask,
  onNavigate,
  onSection,
  onSaved,
}: {
  detail: TaskDetail;
  models: string[];
  section: Section;
  previousTask: string | null;
  nextTask: string | null;
  onNavigate: (taskId: string) => void;
  onSection: (section: Section) => void;
  onSaved: (detail: TaskDetail) => void;
}) {
  return (
    <>
      <section className="task-hero">
        <div className="hero-topline">
          <div className="breadcrumbs">
            <span>{detail.summary.repo}</span>
            <ChevronIcon />
            <span>PR {detail.summary.source_pr ?? "—"}</span>
          </div>
          <div className="queue-navigation">
            <button
              type="button"
              aria-label="Previous task"
              disabled={!previousTask}
              onClick={() => previousTask && onNavigate(previousTask)}
            >
              <ArrowIcon direction="left" />
            </button>
            <button
              type="button"
              aria-label="Next task"
              disabled={!nextTask}
              onClick={() => nextTask && onNavigate(nextTask)}
            >
              <ArrowIcon direction="right" />
            </button>
          </div>
        </div>
        <div className="hero-title-row">
          <div>
            <h2>{taskLabel(detail.summary.task_id)}</h2>
            <div className="hero-id">{detail.summary.task_id}</div>
          </div>
          <StatusPill result={detail.summary.verdict === "accepted" ? "pass" : "fail"}>
            {detail.summary.validation}
          </StatusPill>
        </div>
        <div className="outcome-strip">
          {models.map((model) => (
            <ModelOutcome
              key={model}
              model={model}
              result={detail.summary.model_results[model] ?? "missing"}
            />
          ))}
          <div className="test-counts">
            <span>
              <strong>{detail.summary.fail_to_pass_count}</strong> fail-to-pass
            </span>
            <span>
              <strong>{detail.summary.pass_to_pass_count}</strong> regressions
            </span>
          </div>
        </div>
      </section>
      <nav className="section-tabs" aria-label="Task detail">
        {sections.map((item) => (
          <button
            key={item.id}
            type="button"
            data-active={section === item.id}
            onClick={() => onSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <section className="section-content">
        <SectionContent detail={detail} models={models} section={section} onSaved={onSaved} />
      </section>
    </>
  );
}

function SectionContent({
  detail,
  models,
  section,
  onSaved,
}: {
  detail: TaskDetail;
  models: string[];
  section: Section;
  onSaved: (detail: TaskDetail) => void;
}) {
  if (section === "tests") {
    return <DiffViewer taskId={detail.summary.task_id} kind="test" label="Held-out test patch" />;
  }
  if (section === "gold") {
    return <DiffViewer taskId={detail.summary.task_id} kind="gold" label="Reference patch" />;
  }
  if (section === "validation") return <ValidationView detail={detail} />;
  if (section === "runs") return <RunsView detail={detail} models={models} />;
  if (section === "task") return <CodeBlock value={detail.task_json_text} />;
  return <BriefView detail={detail} onSaved={onSaved} />;
}

function BriefView({
  detail,
  onSaved,
}: {
  detail: TaskDetail;
  onSaved: (detail: TaskDetail) => void;
}) {
  return (
    <div className="brief-grid">
      <article className="surface prompt-surface">
        <SurfaceHeader eyebrow="Evaluation brief" title="What the agent receives">
          <span className="source-chip">{promptSource(detail.prompt_origin)}</span>
        </SurfaceHeader>
        <div className="prompt-copy">{detail.prompt}</div>
      </article>
      <div className="brief-side">
        <ReviewPanel detail={detail} onSaved={onSaved} />
        <EvidenceCard summary={detail.summary} />
      </div>
      {detail.source_trace ? (
        <article className="surface source-surface">
          <SurfaceHeader eyebrow="Provenance" title="Original request history" />
          <SourceSession trace={detail.source_trace} promptOrigin={detail.prompt_origin} />
        </article>
      ) : null}
    </div>
  );
}

function EvidenceCard({ summary }: { summary: TaskSummary }) {
  return (
    <article className="surface evidence-card">
      <SurfaceHeader eyebrow="Evidence" title="Task facts" />
      <dl className="fact-list">
        <Fact label="Repository" value={summary.repo} />
        <Fact label="Workdir" value={summary.workdir} mono />
        <Fact
          label="Source"
          value={
            summary.source_url ? (
              <a href={summary.source_url} target="_blank" rel="noreferrer">
                Pull request {summary.source_pr} <ExternalIcon />
              </a>
            ) : (
              `PR ${summary.source_pr ?? "—"}`
            )
          }
        />
        <Fact label="Solver signal" value={summary.solver_signal} />
      </dl>
      {summary.blockers.length || summary.warnings.length ? (
        <div className="issue-stack">
          {summary.blockers.map((blocker) => (
            <Notice key={blocker} tone="danger">
              {blocker}
            </Notice>
          ))}
          {summary.warnings.map((warning) => (
            <Notice key={warning} tone="warning">
              {warning}
            </Notice>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ReviewPanel({
  detail,
  onSaved,
}: {
  detail: TaskDetail;
  onSaved: (detail: TaskDetail) => void;
}) {
  const [notes, setNotes] = React.useState(detail.summary.quality.review_notes ?? "");
  const [status, setStatus] = React.useState<ReviewStatus>(detail.summary.review_status);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await getJson<TaskDetail>(
        `/api/tasks/${encodeURIComponent(detail.summary.task_id)}/quality`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            review_notes: notes,
            reviewed_warnings: detail.summary.quality.reviewed_warnings ?? [],
            review_status: status,
          }),
        },
      );
      onSaved(next);
    } catch (nextError) {
      setSaveError(String(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="surface review-card">
      <SurfaceHeader eyebrow="Human review" title="Decision">
        <StatusPill result={reviewStatusResult(status)}>{humanize(status)}</StatusPill>
      </SurfaceHeader>
      <label className="field-label" htmlFor="review-status">
        Status
      </label>
      <select
        id="review-status"
        className="input-control"
        value={status}
        onChange={(event) => setStatus(event.target.value as ReviewStatus)}
      >
        {reviewStatuses.map((value) => (
          <option key={value} value={value}>
            {humanize(value)}
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor="review-notes">
        Notes
      </label>
      <textarea
        id="review-notes"
        className="input-control notes-field"
        placeholder="Record why this task is fair or what needs to change."
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      {saveError ? <Notice tone="danger">Review was not saved: {saveError}</Notice> : null}
      <button
        className="button primary full"
        type="button"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Save review"}
      </button>
    </article>
  );
}

function SourceSession({
  trace,
  promptOrigin,
}: {
  trace: SourceTrace;
  promptOrigin: PromptOrigin;
}) {
  const [showAssistant, setShowAssistant] = React.useState(false);
  const selectedIndex =
    promptOrigin.kind === "agent_json" && promptOrigin.path === trace.origin.path
      ? promptOrigin.message_index
      : null;
  const visibleMessages = showAssistant
    ? trace.messages
    : trace.messages.filter((message) => message.role === "user");
  return (
    <div className="source-session">
      <div className="source-controls">
        <span>
          {trace.origin.format} · {trace.origin.path}
        </span>
        <button
          className="text-button"
          type="button"
          onClick={() => setShowAssistant(!showAssistant)}
        >
          {showAssistant ? "Human turns only" : "Include assistant context"}
        </button>
      </div>
      {visibleMessages.map((message) => {
        const selected = message.role === "user" && message.user_message_index === selectedIndex;
        return (
          <div
            className="source-message"
            data-role={message.role}
            data-selected={selected}
            key={`${message.role}:${message.user_message_index ?? "context"}:${message.content}`}
          >
            <div className="source-message-label">
              {message.role === "user" ? "Human" : "Assistant"}
              {selected ? <span>Prompt source</span> : null}
            </div>
            <pre>{message.content}</pre>
          </div>
        );
      })}
    </div>
  );
}

function ValidationView({ detail }: { detail: TaskDetail }) {
  if (!detail.validation_result) {
    return (
      <EmptyState
        title="No validation artifact"
        body="This task has no attached validation result."
      />
    );
  }
  const validation = detail.validation_result;
  const coupling = isRecord(validation.coupling) ? validation.coupling : null;
  return (
    <div className="validation-grid">
      <article className="surface validation-summary">
        <SurfaceHeader eyebrow="Qualification" title="Validation gates" />
        <div className="gate-list">
          <Gate label="No-op exposes the bug" status={String(validation.nop ?? "recorded")} />
          <Gate
            label="Reference solves the task"
            status={String(validation.oracle ?? "recorded")}
          />
          <Gate
            label="Independent coupling review"
            status={String(coupling?.verdict ?? "recorded")}
          />
        </div>
        {typeof coupling?.reason === "string" ? (
          <div className="review-rationale">
            <div className="eyebrow">Reviewer rationale</div>
            <p>{coupling.reason}</p>
          </div>
        ) : null}
      </article>
      <article className="surface raw-validation">
        <SurfaceHeader eyebrow="Artifact" title="Raw validation result" />
        <CodeBlock value={detail.validation_text} />
      </article>
    </div>
  );
}

function RunsView({ detail, models }: { detail: TaskDetail; models: string[] }) {
  const initial =
    models.find((model) => detail.summary.model_results[model] === "fail") ?? models[0] ?? "";
  const [selectedModel, setSelectedModel] = React.useState(initial);
  React.useEffect(() => setSelectedModel(initial), [initial]);
  const run = detail.runs[selectedModel];
  const result = detail.summary.model_results[selectedModel] ?? "missing";
  return (
    <div className="runs-layout">
      <div className="run-selector">
        {models.map((model) => (
          <button
            key={model}
            type="button"
            data-active={selectedModel === model}
            onClick={() => setSelectedModel(model)}
          >
            <div>
              <span className="model-name">{shortModel(model)}</span>
              <span className="model-full">{model}</span>
            </div>
            <StatusPill result={detail.summary.model_results[model] ?? "missing"}>
              {humanize(detail.summary.model_results[model] ?? "missing")}
            </StatusPill>
          </button>
        ))}
      </div>
      {run ? (
        <RunInspector
          key={`${detail.summary.task_id}:${selectedModel}`}
          model={selectedModel}
          result={result}
          run={run}
          taskId={detail.summary.task_id}
        />
      ) : (
        <EmptyState title="No run selected" body="Select a model to inspect its result." />
      )}
    </div>
  );
}

function RunInspector({
  taskId,
  model,
  result,
  run,
}: {
  taskId: string;
  model: string;
  result: ModelResult;
  run: RunDetail;
}) {
  const [showRaw, setShowRaw] = React.useState(false);
  const facts = runFacts(run);
  return (
    <article className="surface run-inspector">
      <SurfaceHeader eyebrow="Selected run" title={model}>
        <StatusPill result={result}>{humanize(result)}</StatusPill>
      </SurfaceHeader>
      {run.stale_reason ? <Notice tone="warning">{run.stale_reason}</Notice> : null}
      <div className="run-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
          </div>
        ))}
      </div>
      <div className="inspector-toolbar">
        <div>
          <h3>Agent patch</h3>
          <p>The code produced during this one-shot trial.</p>
        </div>
        <button className="button ghost" type="button" onClick={() => setShowRaw(!showRaw)}>
          <CodeIcon />
          {showRaw ? "Hide result JSON" : "View result JSON"}
        </button>
      </div>
      {showRaw ? <CodeBlock value={run.result_text || "No result artifact."} /> : null}
      {run.agent_patch ? (
        <DiffViewer
          taskId={taskId}
          kind="agent"
          label={`${shortModel(model)} patch`}
          modelSlug={model}
        />
      ) : (
        <EmptyState title="No patch captured" body="This run did not produce an agent patch." />
      )}
    </article>
  );
}

function DiffViewer({
  taskId,
  kind,
  label,
  modelSlug,
}: {
  taskId: string;
  kind: PatchKind;
  label: string;
  modelSlug?: string;
}) {
  const [patch, setPatch] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const path = modelSlug
    ? `/api/tasks/${encodeURIComponent(taskId)}/patch/${kind}/${encodeURIComponent(modelSlug)}`
    : `/api/tasks/${encodeURIComponent(taskId)}/patch/${kind}`;

  React.useEffect(() => {
    const controller = new AbortController();
    setPatch("");
    setError(null);
    fetch(path, { signal: controller.signal, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Patch fetch failed: ${response.status}`);
        return response.text();
      })
      .then(setPatch)
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(String(nextError));
      });
    return () => controller.abort();
  }, [path]);

  return (
    <div className="diff-surface" data-expanded={expanded}>
      <div className="diff-toolbar">
        <div>
          <div className="eyebrow">Code review</div>
          <h3>{label}</h3>
        </div>
        <div className="diff-actions">
          <button className="button ghost" type="button" onClick={() => setExpanded(!expanded)}>
            <ExpandIcon />
            {expanded ? "Exit full screen" : "Full screen"}
          </button>
          <a className="button ghost" href={path} target="_blank" rel="noreferrer">
            <ExternalIcon />
            Raw patch
          </a>
        </div>
      </div>
      <div className="diff-body">
        {error ? (
          <Notice tone="danger">{error}</Notice>
        ) : patch ? (
          <DiffErrorBoundary key={path}>
            <PatchFiles patch={patch} />
          </DiffErrorBoundary>
        ) : (
          <DiffSkeleton />
        )}
      </div>
    </div>
  );
}

function PatchFiles({ patch }: { patch: string }) {
  const theme = React.useContext(ThemeContext);
  const files = React.useMemo(
    () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
    [patch],
  );
  if (!files.length) return <CodeBlock value={patch} />;
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  const options = {
    themeType: theme,
    diffStyle: narrow ? ("unified" as const) : ("split" as const),
    diffIndicators: "bars" as const,
    overflow: "scroll" as const,
    disableBackground: false,
    disableLineNumbers: false,
    stickyHeader: true,
    lineHoverHighlight: "number" as const,
  };
  return (
    <div className="patch-files">
      {files.map((file) => (
        <FileDiff
          key={`${file.prevName ?? ""}:${file.name}`}
          fileDiff={file}
          disableWorkerPool
          options={options}
        />
      ))}
    </div>
  );
}

class DiffErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }

  componentDidCatch(error: unknown) {
    console.error("Pierre diff renderer failed", error);
  }

  render() {
    if (this.state.error) {
      return <Notice tone="danger">The diff could not render. Open the raw patch instead.</Notice>;
    }
    return this.props.children;
  }
}

function SurfaceHeader({
  eyebrow,
  title,
  children,
}: React.PropsWithChildren<{ eyebrow: string; title: string }>) {
  return (
    <div className="surface-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h3>{title}</h3>
      </div>
      {children ? <div className="surface-action">{children}</div> : null}
    </div>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-mono={mono}>{value}</dd>
    </div>
  );
}

function Gate({ label, status }: { label: string; status: string }) {
  const passes = ["passed", "clean", "accepted", "recorded"].includes(status.toLowerCase());
  return (
    <div className="gate-row">
      <span className="gate-check" data-pass={passes}>
        {passes ? <CheckIcon /> : <MinusIcon />}
      </span>
      <span>{label}</span>
      <strong>{humanize(status)}</strong>
    </div>
  );
}

function ModelOutcome({ model, result }: { model: string; result: ModelResult }) {
  return (
    <div className="model-outcome">
      <ResultDot label={modelInitial(model)} result={result} />
      <div>
        <strong>{shortModel(model)}</strong>
        <span>{humanize(result)}</span>
      </div>
    </div>
  );
}

function ResultDot({ label, result = "missing" }: { label: string; result?: ModelResult }) {
  return (
    <span
      className="result-dot"
      data-result={result}
      role="img"
      aria-label={`${label}: ${humanize(result)}`}
      title={`${label}: ${humanize(result)}`}
    >
      {label}
    </span>
  );
}

function StatusPill({
  result,
  children,
}: React.PropsWithChildren<{ result: ModelResult | "pass" | "fail" }>) {
  return (
    <span className="status-pill" data-result={result}>
      <span />
      {children}
    </span>
  );
}

function Notice({ tone, children }: React.PropsWithChildren<{ tone: "warning" | "danger" }>) {
  return (
    <div className="notice" data-tone={tone}>
      <AlertIcon />
      <span>{children}</span>
    </div>
  );
}

function CodeBlock({ value }: { value: string }) {
  return <pre className="code-block">{value}</pre>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <SearchIcon />
      </div>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-screen">
      <div className="brand-mark">S</div>
      <div>
        <strong>Opening review workspace</strong>
        <span>Loading tasks and model results…</span>
      </div>
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="error-screen">
      <AlertIcon />
      <h1>Could not open the review workspace</h1>
      <p>{error}</p>
      <button className="button primary" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="workspace-skeleton" role="status" aria-label="Loading task">
      <div />
      <div />
      <div />
    </div>
  );
}

function DiffSkeleton() {
  return (
    <div className="diff-skeleton" role="status" aria-label="Loading patch">
      {diffSkeletonWidths.map((width) => (
        <span key={width} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

function runFacts(run: RunDetail): Array<{ label: string; value: string }> {
  const result = run.result;
  if (!result) return [{ label: "Status", value: "No result" }];
  const trial = isRecord(result.trial) ? result.trial : result;
  const verifier = isRecord(trial.verifier_result) ? trial.verifier_result : null;
  const rewards = verifier && isRecord(verifier.rewards) ? verifier.rewards : null;
  const exception = isRecord(trial.exception_info) ? trial.exception_info : null;
  const status =
    typeof result.live_status === "string"
      ? result.live_status
      : run.exists
        ? "completed"
        : "missing";
  const facts = [{ label: "Status", value: humanize(status) }];
  if (rewards) {
    facts.push({ label: "Patch applied", value: scoreLabel(rewards.patch_applied) });
    facts.push({ label: "Fail-to-pass", value: scoreLabel(rewards.fail_to_pass) });
    facts.push({ label: "Regressions", value: scoreLabel(rewards.pass_to_pass) });
  }
  if (typeof exception?.exception_type === "string") {
    facts.push({ label: "Exception", value: exception.exception_type });
  }
  return facts;
}

function scoreLabel(value: unknown): string {
  return value === 1 ? "Passed" : value === 0 ? "Failed" : "—";
}

function sectionFrom(value: string | null): Section {
  if (value === "prompt" || value === "source") return "brief";
  if (value === "test") return "tests";
  if (value && sections.some((section) => section.id === value)) return value as Section;
  return "brief";
}

function promptSource(origin: PromptOrigin): string {
  return origin.kind === "agent_json"
    ? `${origin.format ?? "session"} · message ${origin.message_index ?? "—"}`
    : origin.path;
}

function modelInitial(model: string): string {
  if (model.includes("sol")) return "S";
  if (model.includes("terra")) return "T";
  if (model.includes("luna")) return "L";
  return model.at(0)?.toUpperCase() ?? "?";
}

function shortModel(model: string): string {
  return model.replace(/^gpt-5\.6-/, "").replace(/^openai__/, "");
}

function taskLabel(taskId: string): string {
  return taskId
    .replace(/^agent-host-/, "")
    .split("-")
    .map((word) => (word.length <= 3 && /^\d+$/.test(word) ? word : capitalize(word)))
    .join(" ");
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function humanize(value: string): string {
  return value.split("_").map(capitalize).join(" ");
}

function reviewStatusResult(status: ReviewStatus): ModelResult {
  if (status === "approved") return "pass";
  if (status === "rejected" || status === "changes_requested") return "fail";
  return "missing";
}

function isEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function initialTheme(): Theme {
  const stored = window.localStorage.getItem("selfbench-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="m13 13 4 4" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg aria-hidden="true" data-spinning={spinning} viewBox="0 0 20 20">
      <path d="M16 7a6.5 6.5 0 1 0 .2 5.5" />
      <path d="M16 3v4h-4" />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === "dark" ? (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M16.5 12.6A6.8 6.8 0 0 1 7.4 3.5 6.8 6.8 0 1 0 16.5 12.6Z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden="true" data-direction={direction} viewBox="0 0 20 20">
      <path d="m12.5 4-6 6 6 6" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18">
      <path d="M10 3h5v5M15 3l-7 7" />
      <path d="M14 10v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18">
      <path d="M7 3H3v4M11 3h4v4M7 15H3v-4M11 15h4v-4" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18">
      <path d="m6 5-4 4 4 4M12 5l4 4-4 4M10.5 3 7.5 15" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m3 8 3 3 7-7" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3 8h10" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18">
      <path d="M9 2 1.8 15h14.4L9 2Z" />
      <path d="M9 6v4M9 13h.01" />
    </svg>
  );
}
