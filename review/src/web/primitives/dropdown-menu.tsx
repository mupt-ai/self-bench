// Adapted from shadcn/ui's MIT-licensed Radix Dropdown Menu primitives.
import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;
export function DropdownMenuContent({
  className,
  container,
  ...props
}: ComponentProps<typeof Primitive.Content> & { container?: HTMLElement | null }) {
  return (
    <Primitive.Portal container={container}>
      <Primitive.Content
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          "z-50 min-w-56 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto border border-line-strong bg-surface p-1 font-mono text-[13px] text-ink outline-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label className={cn("px-2 py-2 text-[11px] text-dim", className)} {...props} />;
}
export function DropdownMenuSeparator(props: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className="my-1 h-px bg-line" {...props} />;
}
export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "flex cursor-default items-center gap-2 px-2 py-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-mint data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&>svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem
      className={cn(
        "relative flex cursor-default items-center gap-2 px-2 py-2 pr-8 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-mint",
        className,
      )}
      {...props}
    >
      {children}
      <Primitive.ItemIndicator className="absolute right-2">
        <Check className="size-3.5 text-mint" />
      </Primitive.ItemIndicator>
    </Primitive.RadioItem>
  );
}
