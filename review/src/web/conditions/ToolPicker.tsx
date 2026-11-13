import { useState } from "react";
import type { Harness } from "../../../../src/evaluation/models";
import { cn } from "../primitives/cn";
import { Input } from "../ui";

/**
 * Claude Code's built-in tools, by the names its --allowedTools and --disallowedTools take. Harbor
 * describes these options only as comma-separated text, so the list is kept here: add a tool when
 * Claude Code ships one. Anything else (MCP tools, patterns like `Bash(git:*)`) goes in the text box.
 */
const TOOLS: Partial<Record<Harness, readonly string[]>> = {
  "claude-code": [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "MultiEdit",
    "Glob",
    "Grep",
    "LS",
    "WebFetch",
    "WebSearch",
    "Task",
    "TodoWrite",
    "NotebookEdit",
  ],
};

/** The options, by harness, whose value is a comma-separated list of tool names. */
export const TOOL_PICKERS: Partial<Record<Harness, readonly string[]>> = {
  "claude-code": ["allowed_tools", "disallowed_tools"],
};

const split = (value: string) =>
  value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

/** A tool list as chips to toggle, and a box for any other names, kept as Harbor's comma-separated text. */
export function ToolPicker({
  id,
  label,
  harness,
  value,
  onChange,
}: {
  id: string;
  label: string;
  harness: Harness;
  value: string;
  onChange: (value: string) => void;
}) {
  const known = TOOLS[harness] ?? [];
  const picked = split(value);
  // The box keeps what is typed, trailing comma and all, so a second name can be started.
  const [others, setOthers] = useState(() =>
    picked.filter((name) => !known.includes(name)).join(", "),
  );
  const write = (names: string[]) => onChange(names.join(","));
  return (
    <div className="grid gap-2">
      <fieldset aria-label={label} className="flex flex-wrap gap-1.5 border-0 p-0">
        {known.map((tool) => {
          const on = picked.includes(tool);
          return (
            <button
              key={tool}
              type="button"
              aria-pressed={on}
              className={cn(
                "rounded-md border px-2 py-1 font-mono text-xs",
                on
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
              onClick={() => write(on ? picked.filter((name) => name !== tool) : [...picked, tool])}
            >
              {tool}
            </button>
          );
        })}
      </fieldset>
      <Input
        id={id}
        aria-label={`Other ${label}`}
        className="font-mono"
        placeholder="Other tools, comma-separated: mcp__github, Bash(git:*)"
        value={others}
        onChange={(event) => {
          setOthers(event.target.value);
          write([...picked.filter((name) => known.includes(name)), ...split(event.target.value)]);
        }}
      />
    </div>
  );
}
