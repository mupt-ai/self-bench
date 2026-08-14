import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, Menu, RefreshCw, Search } from "lucide-react";
import { EvaluationView } from "./components/EvaluationView";
import { getEvaluation, listEvaluations } from "./lib/api";
import type { Evaluation, EvaluationSummary } from "./lib/types";

export function App() {
  const [summaries, setSummaries] = useState<EvaluationSummary[]>([]);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [query, setQuery] = useState("");

  const loadSummaries = useCallback(async (preferredID?: string) => {
    setLoading(true);
    setListError(null);
    try {
      const loaded = await listEvaluations();
      setSummaries(loaded);
      setSelectedID((current) => preferredID ?? current ?? loaded[0]?.id ?? null);
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : "Could not load evaluations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSummaries();
  }, [loadSummaries]);

  useEffect(() => {
    if (!selectedID) {
      setEvaluation(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setEvaluation(null);
    setDetailError(null);
    getEvaluation(selectedID, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setEvaluation(loaded);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setDetailError(caught instanceof Error ? caught.message : "Could not load evaluation");
      });
    return () => controller.abort();
  }, [selectedID, detailReload]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return summaries;
    return summaries.filter((item) => `${item.name} ${item.benchmark} ${item.description ?? ""}`.toLowerCase().includes(needle));
  }, [query, summaries]);

  function selectEvaluation(id: string) {
    setSelectedID(id);
    setMobileNavOpen(false);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>eval<span>/studio</span></span>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label"><span>Evaluations</span><button type="button" onClick={() => void loadSummaries()} aria-label="Refresh evaluations"><RefreshCw size={12} /></button></div>
          <label className="sidebar-search">
            <Search size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an eval" />
          </label>
          <div className="eval-nav-list">
            {filtered.map((item) => (
              <button key={item.id} type="button" className={item.id === selectedID ? "active" : ""} onClick={() => selectEvaluation(item.id)}>
                <span className="eval-nav-icon"><FlaskConical size={13} /></span>
                <span className="eval-nav-copy"><strong>{item.name}</strong><small>{item.run_count} runs · {item.task_count} tasks</small></span>
                <i />
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-footer">
          <span className={`system-status ${listError || detailError ? "down" : ""}`}><i /> {listError || detailError ? "API unreachable" : "API connected"}</span>
        </div>
      </aside>

      {mobileNavOpen && <button className="nav-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      <main className="workspace">
        <header className="mobile-header">
          <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={19} /></button>
          <div className="brand compact"><span className="brand-mark"><i /><i /><i /></span>eval<span>/studio</span></div>
        </header>

        {listError ? (
          <div className="error-state"><strong>Could not open Eval Studio</strong><p>{listError}</p><button type="button" onClick={() => void loadSummaries()}>Try again</button></div>
        ) : loading ? (
          <LoadingState />
        ) : summaries.length === 0 ? (
          <EmptyState />
        ) : detailError ? (
          <div className="error-state"><strong>Could not open this evaluation</strong><p>{detailError}</p><button type="button" onClick={() => setDetailReload((value) => value + 1)}>Try again</button></div>
        ) : evaluation ? (
          <EvaluationView evaluation={evaluation} />
        ) : (
          <LoadingState />
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="empty-state">
      <div className="empty-current" aria-hidden="true"><i /><i /><i /><b /></div>
      <p className="eyebrow">Evaluation workspace</p>
      <h1>Results worth looking at.</h1>
      <p>No evaluations yet. Import one through the API to compare models, providers, harnesses, thinking levels, and the actual cost of every task.</p>
      <div className="empty-actions">
        <a className="button primary" href="/api/template.csv"><span>↓</span> Download CSV template</a>
      </div>
      <div className="empty-format"><span>Import via</span><code>POST /api/evaluations</code><small>CSV · JSON · 25 MB max</small></div>
    </section>
  );
}

function LoadingState() {
  return <div className="loading-state"><span /><p>Opening evaluation workspace…</p></div>;
}
