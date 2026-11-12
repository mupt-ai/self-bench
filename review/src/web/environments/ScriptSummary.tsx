/** As much of a script as a table row shows; the row's details hold all of it. */
const PREVIEW_LENGTH = 200;

/** An environment's script on one line: its commands, without blank lines and comments. */
export function ScriptSummary({ script }: { script?: string }) {
  if (script === undefined)
    return <span className="text-muted-foreground">Script not recorded</span>;
  const commands = script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("; ");
  return (
    <span className="line-clamp-1 font-mono break-all text-muted-foreground">
      {commands.length > PREVIEW_LENGTH ? `${commands.slice(0, PREVIEW_LENGTH)}…` : commands}
    </span>
  );
}
