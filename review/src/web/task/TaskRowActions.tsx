import { Ellipsis, Trash2 } from "lucide-react";
import { useRef } from "react";
import type { TaskItem } from "../api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import { Button } from "../ui";

export function TaskRowActions({
  task,
  disabled,
  onDelete,
}: {
  task: TaskItem;
  disabled: boolean;
  onDelete: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const openingDialog = useRef(false);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) openingDialog.current = false;
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          aria-label={`Task Actions for ${task.taskId} from ${task.runId}`}
          disabled={disabled}
          title={
            disabled
              ? "Task actions are unavailable during generation or deletion."
              : "Task Actions"
          }
          className="size-8"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-40"
        onCloseAutoFocus={(event) => {
          if (!openingDialog.current) return;
          event.preventDefault();
          openingDialog.current = false;
          trigger.current?.focus();
          onDelete();
        }}
      >
        <DropdownMenuItem
          className="text-destructive data-[highlighted]:text-destructive"
          onSelect={() => {
            openingDialog.current = true;
          }}
        >
          <Trash2 aria-hidden="true" />
          Delete Task
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
