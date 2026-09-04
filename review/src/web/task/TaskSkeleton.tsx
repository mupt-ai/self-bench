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
    <div className="task-shell skeleton" aria-busy="true">
      <header className="task-head">
        <div className="task-head-main">
          <nav className="crumbs">
            <Link to="/">Repositories</Link>
            <span aria-hidden="true">/</span>
            <Link to={`/repos/${fullName}`}>{fullName}</Link>
            <span aria-hidden="true">/</span>
            <span>{taskId}</span>
          </nav>
          <div className="task-head-row">
            <h1>{taskId}</h1>
            <span className="skeleton-bar stamp" />
            <span className="skeleton-bar stamp wide" />
          </div>
          <span className="skeleton-bar thin" style={{ width: 520, marginTop: 10 }} />
        </div>
        <div className="review-bar">
          <span className="skeleton-bar button" />
          <span className="skeleton-bar button" />
        </div>
      </header>
      <div className="task-body">
        <aside className="task-files">
          <div className="task-files-head">
            <span className="eyebrow">Files</span>
          </div>
          <div className="task-files-body skeleton-tree">
            {TREE_ROWS.map((row) => (
              <span
                key={row.id}
                className="skeleton-bar thin"
                style={{ width: row.width, marginLeft: row.indent }}
              />
            ))}
          </div>
        </aside>
        <section className="task-pane">
          <div className="tabs">
            <span className="tab active">File</span>
            <span className="tab">Environment</span>
            <span className="tab">Pipeline</span>
          </div>
          <div className="sheet-body">
            <div className="block">
              <div className="block-head">
                <span className="skeleton-bar thin" style={{ width: 180, marginTop: 0 }} />
              </div>
              <div className="skeleton-lines">
                {TEXT_LINES.map((line) => (
                  <span key={line.id} className="skeleton-bar thin" style={{ width: line.width }} />
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
