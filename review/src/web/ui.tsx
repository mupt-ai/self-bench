import type { ComponentProps, ReactNode } from "react";

export const buttonStyles = {
  primary:
    "inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-mint bg-mint px-4 font-sans text-sm font-bold text-bg transition-colors hover:border-mint-bright hover:bg-mint-bright disabled:cursor-not-allowed disabled:opacity-40",
  secondary:
    "inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-line-strong bg-transparent px-4 font-sans text-sm font-bold text-ink transition-colors hover:border-mint hover:text-mint-bright disabled:cursor-not-allowed disabled:opacity-40",
  ghost:
    "inline-flex min-h-9 shrink-0 items-center justify-center gap-2 px-3 font-sans text-sm text-muted hover:text-mint-bright disabled:cursor-not-allowed disabled:opacity-40",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof buttonStyles }) {
  return <button {...props} className={`${buttonStyles[variant]} ${className}`} />;
}

const control =
  "w-full min-w-0 rounded-none border border-line-strong bg-bg px-3 py-2.5 font-mono text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint disabled:cursor-not-allowed disabled:opacity-40";

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input {...props} className={`${control} ${className}`} />;
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block min-w-0">
      <select {...props} className={`${control} appearance-none pr-10 ${className}`} />
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="pointer-events-none absolute top-1/2 right-3.5 size-3 -translate-y-1/2 fill-none stroke-muted"
        strokeWidth="1.25"
      >
        <path d="m3 4.5 3 3 3-3" />
      </svg>
    </span>
  );
}

export function DataTable({ className = "", ...props }: ComponentProps<"table">) {
  return (
    <section className="overflow-x-auto border border-line-strong" aria-label="Scrollable Table">
      <table
        {...props}
        className={`w-full border-collapse text-left text-sm [&_th]:px-4 [&_th]:py-4 [&_th]:font-mono [&_th]:text-sm [&_th]:font-normal [&_th]:text-muted [&_td]:border-t [&_td]:border-line [&_td]:px-4 [&_td]:py-4 [&_small]:mt-2 [&_small]:block [&_small]:font-mono [&_small]:text-sm [&_small]:text-muted ${className}`}
      />
    </section>
  );
}

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:gap-6">
      <div>
        <h1 className="mt-1.5 font-sans text-xl leading-tight font-semibold tracking-[-0.01em]">
          {title}
        </h1>
        {description && <p className="mt-2 text-base text-muted">{description}</p>}
      </div>
      {children}
    </header>
  );
}

export function PageContent({ className = "", ...props }: ComponentProps<"section">) {
  return (
    <section
      {...props}
      className={`mx-auto w-full max-w-[1600px] [&_h2]:text-lg [&_h2]:font-medium [&_h3]:text-base [&_h4]:mt-6 [&_h4]:mb-3 [&_h4]:font-mono [&_h4]:text-sm [&_h4]:font-medium [&_h4]:text-muted [&_h5]:mt-3 [&_h5]:mb-1.5 [&_h5]:text-dim [&_details]:my-3 [&_details]:border [&_details]:border-line [&_details]:bg-bg [&_details]:px-3.5 [&_details]:py-3 [&_summary]:cursor-pointer [&_summary]:font-mono [&_summary]:text-sm [&_summary]:text-muted [&_pre]:mt-3 [&_pre]:max-h-[440px] [&_pre]:overflow-auto [&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-6 [&_pre]:whitespace-pre-wrap [&_pre]:text-muted [&_pre]:wrap-anywhere ${className}`}
    />
  );
}

export function RunStatus({ value }: { value: string }) {
  const color =
    value === "completed"
      ? "text-mint"
      : value === "failed"
        ? "text-danger"
        : value === "running"
          ? "text-warning"
          : "text-muted";
  return <span className={`font-mono text-sm uppercase ${color}`}>{value}</span>;
}
