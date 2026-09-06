import { Link } from "react-router";

const TREE_ROWS = [
  { id: "env", width: 160, indent: 20 },
  { id: "dockerfile", width: 120, indent: 34 },
  { id: "setup", width: 140, indent: 34 },
  { id: "solution", width: 100, indent: 20 },
  { id: "patch", width: 150, indent: 34 },
  { id: "tests", width: 110, indent: 20 },
  { id: "test-sh", width: 130, indent: 34 },
];
const TEXT_LINES = [
  { id: "l1", width: "70%" },
  { id: "l2", width: "90%" },
  { id: "l3", width: "55%" },
  { id: "l4", width: "80%" },
  { id: "l5", width: "40%" },
  { id: "l6", width: "85%" },
  { id: "l7", width: "60%" },
];

/** The task page's frame with pulsing bars in place of the header stamps, tree, and file. */
export function TaskSkeleton({ fullName, taskId }: { fullName: string; taskId: string }) {
  return (
    <div
      className="grid h-[calc(100vh-56px)] min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] pointer-events-none"
      aria-busy="true"
    >
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-line bg-surface px-4 pt-4.5 pb-4 sm:px-[var(--site-gutter)]">
        <div className="min-w-0">
          <nav className="mb-3.5 flex flex-wrap gap-2 font-mono text-xs font-medium text-dim [&_a]:text-muted [&_a:hover]:text-mint-bright">
            <Link to="/">Repositories</Link>
            <span aria-hidden="true">/</span>
            <Link to={`/repos/${fullName}`}>{fullName}</Link>
            <span aria-hidden="true">/</span>
            <span>{taskId}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 [&_h1]:font-mono [&_h1]:text-lg [&_h1]:leading-tight [&_h1]:font-semibold [&_h1]:wrap-anywhere">
            <h1>{taskId}</h1>
            <span className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none h-5 w-11" />
            <span className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none h-5 w-11 w-[110px]" />
          </div>
          <span
            className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none mt-1.5 h-2.5 opacity-70"
            style={{ width: 520, marginTop: 10 }}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2.5 pt-2 sm:pt-5.5">
          <span className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none h-9 w-[88px]" />
          <span className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none h-9 w-[88px]" />
        </div>
      </header>
      <div className="grid min-h-0 grid-cols-[160px_minmax(0,1fr)] md:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-line bg-bg">
          <div className="flex h-11 items-center gap-2.5 border-b border-line px-4">
            <span className="font-mono text-[10px] font-medium tracking-[0.14em] text-mint uppercase">
              Files
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto flex flex-col gap-2 py-3.5">
            {TREE_ROWS.map((row) => (
              <span
                key={row.id}
                className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none mt-1.5 h-2.5 opacity-70"
                style={{ width: row.width, marginLeft: row.indent }}
              />
            ))}
          </div>
        </aside>
        <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
          <div className="tabs">
            <span className="tab active">File</span>
            <span className="tab">Environment</span>
            <span className="tab">Pipeline</span>
          </div>
          <div className="sheet-body">
            <div className="ledger-block">
              <div className="block-head">
                <span
                  className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none mt-1.5 h-2.5 opacity-70"
                  style={{ width: 180, marginTop: 0 }}
                />
              </div>
              <div className="flex flex-col gap-2.5 px-6 py-4.5">
                {TEXT_LINES.map((line) => (
                  <span
                    key={line.id}
                    className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none mt-1.5 h-2.5 opacity-70"
                    style={{ width: line.width }}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
