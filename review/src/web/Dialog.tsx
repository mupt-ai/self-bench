import { X } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { cn } from "./primitives/cn";
import { useModalDialog } from "./useModalDialog";

const widths = { small: "max-w-md", medium: "max-w-lg", large: "max-w-xl", wide: "max-w-5xl" };

export function Dialog({
  initialFocus,
  onDismiss,
  busy = false,
  size = "medium",
  placement = "center",
  className,
  ...props
}: Omit<ComponentProps<"dialog">, "ref" | "onCancel"> & {
  initialFocus: RefObject<HTMLElement | null>;
  onDismiss(): void;
  busy?: boolean;
  size?: keyof typeof widths;
  placement?: "center" | "right";
}) {
  const dialog = useModalDialog(initialFocus);
  return (
    <dialog
      {...props}
      ref={dialog}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onDismiss();
      }}
      closedby="none"
      onPointerDown={(event) => {
        if (busy || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const slop = 2;
        if (
          event.clientX < bounds.left - slop ||
          event.clientX > bounds.right + slop ||
          event.clientY < bounds.top - slop ||
          event.clientY > bounds.bottom + slop
        )
          onDismiss();
      }}
      className={cn(
        "fixed inset-0 w-[calc(100%_-_2rem)] overflow-y-auto border border-border bg-card p-0 text-foreground shadow-2xl shadow-black/50 backdrop:bg-black/60 backdrop:backdrop-blur-[2px] focus:outline-none",
        placement === "center"
          ? "m-auto max-h-[calc(100dvh_-_2rem)] rounded-lg"
          : "my-0 mr-0 ml-auto h-dvh max-h-none w-full border-y-0 border-r-0",
        widths[size],
        className,
      )}
    />
  );
}

export function DialogHeader({
  title,
  description,
  titleId,
  descriptionId,
  onClose,
  closeRef,
  busy,
}: {
  title: ReactNode;
  description?: ReactNode;
  titleId: string;
  descriptionId?: string;
  onClose(): void;
  closeRef?: RefObject<HTMLButtonElement | null>;
  busy?: boolean;
}) {
  return (
    <header className="border-b border-border px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between gap-4">
        <h2 id={titleId} className="min-w-0 text-base leading-6 font-medium">
          {title}
        </h2>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
          className="-my-1 -mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      {description && (
        <p
          id={descriptionId}
          className="mt-1.5 break-words text-[13px] leading-5 text-muted-foreground"
        >
          {description}
        </p>
      )}
    </header>
  );
}

export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "min-w-0 space-y-4 whitespace-normal [overflow-wrap:anywhere] p-4 sm:p-6",
        className,
      )}
    />
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      {...props}
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border p-4 sm:px-6",
        className,
      )}
    />
  );
}
