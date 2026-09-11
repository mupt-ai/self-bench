import { Ellipsis, RefreshCw, Trash2 } from "lucide-react";
import { useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import { Button } from "../ui";

export function CredentialActions({
  name,
  onReplace,
  onDelete,
}: {
  name: string;
  onReplace(): void;
  onDelete(): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<"replace" | "delete" | null>(null);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) pending.current = null;
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${name}`}
          title="Credential Actions"
          className="shrink-0"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          if (!action) return;
          event.preventDefault();
          pending.current = null;
          trigger.current?.focus();
          if (action === "replace") onReplace();
          else onDelete();
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            pending.current = "replace";
          }}
        >
          <RefreshCw aria-hidden="true" />
          Replace
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive data-[highlighted]:text-destructive"
          onSelect={() => {
            pending.current = "delete";
          }}
        >
          <Trash2 aria-hidden="true" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
