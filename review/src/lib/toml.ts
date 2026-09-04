export type TomlValue = string | number | boolean | TomlValue[];

export interface TomlSection {
  name: string;
  entries: [string, TomlValue][];
  /** True for `[[array.of.tables]]` entries. */
  repeated: boolean;
}

/**
 * Minimal TOML reader for the subset Harbor task files use: bare and quoted keys,
 * strings, numbers, booleans, and arrays of those. Anything else is kept verbatim as a
 * string so the viewer never hides a line.
 */
export function parseToml(text: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection = { name: "", entries: [], repeated: false };
  sections.push(current);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = stripComment(raw).trim();
    if (!line) continue;
    const repeated = /^\[\[(.+)\]\]$/.exec(line);
    const single = /^\[(.+)\]$/.exec(line);
    if (repeated?.[1] || single?.[1]) {
      current = {
        name: (repeated?.[1] ?? single?.[1] ?? "").trim(),
        entries: [],
        repeated: Boolean(repeated),
      };
      sections.push(current);
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) {
      current.entries.push([line, ""]);
      continue;
    }
    const key = unquote(line.slice(0, equals).trim());
    let valueText = line.slice(equals + 1).trim();
    while (valueText.startsWith("[") && !balanced(valueText) && index + 1 < lines.length) {
      index += 1;
      valueText += ` ${stripComment(lines[index] ?? "").trim()}`;
    }
    current.entries.push([key, parseValue(valueText)]);
  }
  return sections.filter((section) => section.entries.length > 0 || section.name);
}

export function tomlLookup(
  sections: TomlSection[],
  section: string,
  key: string,
): TomlValue | undefined {
  return sections
    .find((entry) => entry.name === section)
    ?.entries.find(([name]) => name === key)?.[1];
}

export function formatTomlValue(value: TomlValue): string {
  if (Array.isArray(value)) return value.map(formatTomlValue).join(", ");
  return String(value);
}

function parseValue(text: string): TomlValue {
  if (text.startsWith("[") && text.endsWith("]")) {
    return splitArray(text.slice(1, -1)).map(parseValue);
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return JSON.parse(text) as string;
  if (/^'.*'$/.test(text)) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) return Number(text);
  return text;
}

function splitArray(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (inString) {
      current += char;
      if (char === "\\") {
        current += body[index + 1] ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      current += char;
    } else if (char === "[") {
      depth += 1;
      current += char;
    } else if (char === "]") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function balanced(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
  }
  return depth <= 0 && !inString;
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && inString) index += 1;
    else if (char === '"') inString = !inString;
    else if (char === "#" && !inString) return line.slice(0, index);
  }
  return line;
}

function unquote(key: string): string {
  return /^"(.*)"$/.test(key) ? key.slice(1, -1) : key;
}
