export function TaskListSkeleton() {
  return (
    <ul
      className="list-none border border-line [&_li+li]:border-t [&_li+li]:border-line pointer-events-none"
      aria-busy="true"
      aria-label="Loading tasks"
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li key={index}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-ink hover:bg-surface sm:flex-nowrap sm:gap-6">
            <span className="flex min-w-0 flex-col gap-1">
              <span
                className="block h-[13px] animate-pulse bg-surface-3 motion-reduce:animate-none"
                style={{ width: `${220 + (index % 3) * 60}px` }}
              />
              <span
                className="block animate-pulse bg-surface-3 motion-reduce:animate-none mt-1.5 h-2.5 opacity-70"
                style={{ width: `${380 + (index % 2) * 120}px` }}
              />
            </span>
            <span className="flex shrink-0 items-center gap-2.5">
              <span className="block animate-pulse bg-surface-3 motion-reduce:animate-none h-5 w-11" />
              <span className="block animate-pulse bg-surface-3 motion-reduce:animate-none h-5 w-[110px]" />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
