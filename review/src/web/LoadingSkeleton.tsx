export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse bg-muted motion-reduce:animate-none ${className}`}
    />
  );
}

export function CardGridSkeleton({ label, cards = 4 }: { label: string; cards?: number }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      <span className="sr-only">{label}</span>
      {(["first", "second", "third", "fourth"] as const).slice(0, cards).map((key) => (
        <div key={key} className="panel p-5" aria-hidden="true">
          <Skeleton className="h-4 w-40 max-w-full" />
          <Skeleton className="mt-2 h-3 w-56 max-w-full" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="panel divide-y divide-border">
      <span className="sr-only">{label}</span>
      {["first", "second", "third", "fourth"].slice(0, rows).map((key) => (
        <div key={key} className="flex items-center gap-4 px-4 py-4" aria-hidden="true">
          <Skeleton className="size-8 shrink-0" />
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
    <div
      className="min-h-screen bg-background md:pl-64"
      role="status"
      aria-label="Loading Workspace"
    >
      <span className="sr-only">Loading workspace…</span>
      <aside
        aria-hidden="true"
        className="fixed inset-y-0 left-0 hidden w-64 space-y-6 border-r border-border bg-background p-4 md:block"
      >
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-32" />
      </aside>
      <div
        aria-hidden="true"
        className="flex h-16 items-center justify-end border-b border-border px-6"
      >
        <Skeleton className="size-7" />
      </div>
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8" aria-hidden="true">
        <Skeleton className="h-6 w-52" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <ListSkeleton label="Loading Content" />
      </div>
    </div>
  );
}
