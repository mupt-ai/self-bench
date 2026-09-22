import { X } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { cn } from "./primitives/cn";
import { Button } from "./ui";
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
        "fixed inset-0 w-[calc(100%_-_2rem)] overflow-y-auto border-[1.5px] border-foreground/15 bg-background p-0 text-foreground shadow-[0_24px_64px_-16px_rgb(0_0_0/0.35)] backdrop:bg-[hsl(30_8%_12%/0.35)] backdrop:backdrop-blur-[2px]",
        placement === "center"
          ? "m-auto max-h-[calc(100dvh_-_2rem)]"
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
    <header className="flex items-start justify-between gap-4 border-b border-border p-4 sm:px-6 sm:py-5">
      <div className="min-w-0">
        <h2 id={titleId} className="text-lg leading-7 font-semibold tracking-tight">
          {title}
        </h2>
        {description && (
          <p
            id={descriptionId}
            className="mt-1 break-words text-sm leading-6 text-muted-foreground"
          >
            {description}
          </p>
        )}
      </div>
      <Button
        ref={closeRef}
        size="icon"
        variant="ghost"
        aria-label="Close"
        disabled={busy}
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </header>
  );
}

export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("space-y-4 p-4 sm:p-6", className)} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      {...props}
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card p-4 sm:px-6",
        className,
      )}
    />
  );
}
