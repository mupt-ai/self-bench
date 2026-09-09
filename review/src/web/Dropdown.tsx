import React from "react";

export interface DropdownProps {
  /** Trigger contents; the wrapper supplies the button, caret, and open state. */
  trigger: React.ReactNode;
  /** Panel contents; receives a closer so items can dismiss the menu. */
  children: (close: () => void) => React.ReactNode;
  label: string;
  className?: string;
  align?: "left" | "right";
  above?: boolean;
}

/** A square-cornered menu anchored under its trigger. Closes on outside click and Escape. */
export function Dropdown({
  trigger,
  children,
  label,
  className,
  align = "right",
  above = false,
}: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={`relative ${className ?? ""}`} ref={root}>
      <button
        type="button"
        className="group/trigger flex h-9 items-center gap-2 border border-transparent bg-transparent pr-2.5 pl-2 font-mono text-sm font-medium text-ink hover:border-line-strong hover:bg-surface-2 aria-expanded:border-line-strong aria-expanded:bg-surface-2"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
        <svg
          className="h-1.5 w-2.5 text-dim transition-transform group-aria-expanded/trigger:rotate-180 group-aria-expanded/trigger:text-mint"
          viewBox="0 0 10 6"
          aria-hidden="true"
        >
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute ${above ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"} z-10 min-w-[220px] border border-line-strong bg-surface-2 ${align === "right" ? "right-0" : "right-0 sm:right-auto sm:left-0"}`}
          role="menu"
          aria-label={label}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** A 24px square avatar with a lettered fallback. */
export function Avatar({ login, url, size = 24 }: { login: string; url?: string; size?: number }) {
  if (url) {
    return (
      <img className="block shrink-0 bg-surface-3" src={url} alt="" width={size} height={size} />
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center border border-line-strong bg-surface-3 font-mono text-xs font-medium text-mint"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}
