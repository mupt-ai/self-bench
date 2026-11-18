// Adapted from shadcn/ui's MIT-licensed Sidebar primitives for SelfBench.
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { PanelLeft } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "../ui";
import { cn } from "./cn";

export function SidebarTrigger({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", className)}
      {...props}
    >
      <PanelLeft strokeWidth={1.5} aria-hidden="true" />
    </Button>
  );
}

export function SidebarInset({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn("relative flex w-full min-w-0 flex-1 flex-col bg-background", className)}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  );
}

export function SidebarGroupContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-group-content" className={cn("w-full text-sm", className)} {...props} />
  );
}

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
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]/sidebar:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}
export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
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
  // As on dari.dev: the page you are on is a quiet filled row with a mint icon; others are muted
  // with a faint icon until pointed at.
  "peer/menu-button relative flex w-full items-center gap-2 overflow-visible rounded-md p-2 text-left text-sm text-muted-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50 group-data-[collapsible=icon]/sidebar:!size-8 group-data-[collapsible=icon]/sidebar:!p-2 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-faint [&>svg]:data-[active=true]:text-brand",
  {
    variants: {
      active: { true: "text-foreground", false: "text-muted-foreground" },
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
