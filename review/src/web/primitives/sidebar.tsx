// Adapted from shadcn/ui's MIT-licensed Sidebar primitives for SelfBench's square theme.
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}
export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto", className)}
      {...props}
    />
  );
}
export function SidebarGroupLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 transition-[margin,opacity] duration-200 ease-linear",
        className,
      )}
      {...props}
    />
  );
}
export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}
export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}
export function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}
const menuButton = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      active: { true: "bg-sidebar-accent text-brand", false: "text-sidebar-foreground" },
      size: { default: "h-8 text-sm", lg: "h-12 text-sm" },
    },
    defaultVariants: { active: false, size: "default" },
  },
);
export function SidebarMenuButton({
  asChild = false,
  isActive = false,
  size = "default",
  className,
  ...props
}: ComponentProps<"button"> & { asChild?: boolean; isActive?: boolean; size?: "default" | "lg" }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive}
      className={cn(menuButton({ active: isActive, size }), className)}
      {...props}
    />
  );
}
