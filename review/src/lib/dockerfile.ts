export interface DockerInstruction {
  instruction: string;
  args: string;
  line: number;
}

const INSTRUCTIONS =
  /^(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b[ \t]*([\s\S]*)$/i;

/** Join continuation lines and split a Dockerfile into its instructions. */
export function parseDockerfile(text: string): DockerInstruction[] {
  const output: DockerInstruction[] = [];
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const start = index;
    let logical = lines[index] ?? "";
    while (logical.trimEnd().endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      logical = `${logical.trimEnd().slice(0, -1)}\n${lines[index] ?? ""}`;
    }
    index += 1;
    const trimmed = logical.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = INSTRUCTIONS.exec(trimmed);
    if (match?.[1]) {
      output.push({ instruction: match[1].toUpperCase(), args: match[2] ?? "", line: start + 1 });
    } else {
      output.push({ instruction: "?", args: trimmed, line: start + 1 });
    }
  }
  return output;
}

/** ENV lines as name/value pairs. Handles `ENV A=1 B="x"` and `ENV A 1`. */
export function dockerfileEnvironment(instructions: DockerInstruction[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const entry of instructions) {
    if (entry.instruction !== "ENV") continue;
    const legacy = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(entry.args);
    if (legacy?.[1] && !entry.args.includes("=")) {
      pairs.push([legacy[1], legacy[2] ?? ""]);
      continue;
    }
    const pattern = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g;
    for (const match of entry.args.matchAll(pattern)) {
      const raw = match[2] ?? "";
      const value = /^".*"$/.test(raw) ? safeJsonString(raw) : raw.replace(/^'|'$/g, "");
      pairs.push([match[1] ?? "", value]);
    }
  }
  return pairs;
}

function safeJsonString(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}
