export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse bg-surface-3 motion-reduce:animate-none ${className}`}
    />
  );
}

export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="divide-y divide-line border border-line bg-surface"
    >
      <span className="sr-only">{label}</span>
      {["first", "second", "third", "fourth"].slice(0, rows).map((key) => (
        <div key={key} className="flex items-center gap-4 px-5 py-5" aria-hidden="true">
          <Skeleton className="size-10 shrink-0" />
          <div className="min-w-0 flex-1 space-y-3">
            <Skeleton className="h-3.5 w-36 max-w-full" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="hidden h-5 w-20 sm:block" />
        </div>
      ))}
    </div>
  );
}

export function SiteSkeleton() {
  return (
    <div className="min-h-screen lg:pl-60" role="status" aria-label="Loading Workspace">
      <span className="sr-only">Loading workspace…</span>
      <aside
        aria-hidden="true"
        className="fixed inset-y-0 left-0 hidden w-60 space-y-6 border-r border-line bg-surface p-6 lg:block"
      >
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-32" />
      </aside>
      <div
        aria-hidden="true"
        className="flex h-14 items-center justify-end border-b border-line px-8"
      >
        <Skeleton className="size-7" />
      </div>
      <div className="space-y-7 px-4 py-8 sm:px-8" aria-hidden="true">
        <Skeleton className="h-6 w-52" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <ListSkeleton label="Loading Content" />
      </div>
    </div>
  );
}
