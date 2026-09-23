// Adapted from shadcn/ui's MIT-licensed Radix Tooltip primitives for SelfBench's square theme.
import * as Primitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

/** An info hint. With no children it renders an info icon carrying the hint as its accessible
 * label; wrapping an existing control (an icon button, a link) attaches the hint to it. */
export function InfoTooltip({
  label,
  children,
  className,
  contentClassName,
}: {
  label: string;
  children?: ReactNode;
  className?: string;
  /** Classes for the hint's card, for example theme colours instead of the inverted default. */
  contentClassName?: string;
}) {
  return (
    <Primitive.Provider delayDuration={150}>
      <Primitive.Root>
        {children !== undefined && children !== null ? (
          <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        ) : (
          <Primitive.Trigger asChild>
            <button
              type="button"
              aria-label={label}
              className={cn(
                "inline-flex cursor-help items-center text-muted-foreground hover:text-foreground",
                className,
              )}
            >
              <Info aria-hidden="true" className="size-3.5" />
            </button>
          </Primitive.Trigger>
        )}
        <TooltipContent side="top" className={contentClassName}>
          {label}
        </TooltipContent>
      </Primitive.Root>
    </Primitive.Provider>
  );
}

function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  // Rendered inline rather than through a portal: tooltips inside the app's native
  // <dialog> panels would otherwise land behind the modal's top layer.
  return (
    <Primitive.Content
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-max max-w-72 bg-foreground px-2.5 py-1.5 text-xs leading-5 font-medium text-background shadow-md",
        className,
      )}
      {...props}
    />
  );
}
