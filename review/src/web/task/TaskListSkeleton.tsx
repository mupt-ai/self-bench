/** Placeholder rows while the artifact store is listed; same shape as real rows so nothing jumps. */
export function TaskListSkeleton() {
  return (
    <ul className="task-list skeleton" aria-busy="true" aria-label="Loading tasks">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li key={index}>
          <div className="task-row">
            <span className="task-row-main">
              <span className="skeleton-bar" style={{ width: `${220 + (index % 3) * 60}px` }} />
              <span
                className="skeleton-bar thin"
                style={{ width: `${380 + (index % 2) * 120}px` }}
              />
            </span>
            <span className="task-row-side">
              <span className="skeleton-bar stamp" />
              <span className="skeleton-bar stamp wide" />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
