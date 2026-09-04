import React from "react";

export interface DropdownProps {
  /** Trigger contents; the wrapper supplies the button, caret, and open state. */
  trigger: React.ReactNode;
  /** Panel contents; receives a closer so items can dismiss the menu. */
  children: (close: () => void) => React.ReactNode;
  label: string;
  className?: string;
  align?: "left" | "right";
}

/** A square-cornered menu anchored under its trigger. Closes on outside click and Escape. */
export function Dropdown({ trigger, children, label, className, align = "right" }: DropdownProps) {
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
    <div className={`dropdown ${open ? "open" : ""} ${className ?? ""}`} ref={root}>
      <button
        type="button"
        className="dropdown-trigger"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
        <svg className="dropdown-caret" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className={`dropdown-panel align-${align}`} role="menu" aria-label={label}>
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
      <img
        className="avatar"
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="avatar avatar-fallback"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}
