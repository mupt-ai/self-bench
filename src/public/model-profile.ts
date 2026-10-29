/** The lines of a configuration's routing profile (Model Summaries), in order. */
const LABELS = ["Send it", "Avoid or review", "How it fails"] as const;

const LABELED = new RegExp(
  `^\\s*(?:[-*]\\s*)?\\**\\s*(${LABELS.join("|")})\\s*\\**\\s*:\\s*\\**\\s*(.*)$`,
  "i",
);

/**
 * A configuration's summary as its labeled routing-profile lines, however the model formatted
 * them; undefined for a summary written before profiles, which is a plain paragraph.
 */
export function profileLines(text: string): { label: string; text: string }[] | undefined {
  const lines: { label: string; text: string }[] = [];
  for (const raw of text.split("\n")) {
    const match = LABELED.exec(raw);
    const label = LABELS.find((entry) => entry.toLowerCase() === match?.[1]?.toLowerCase());
    if (label) lines.push({ label, text: (match?.[2] ?? "").replace(/\*+/g, "").trim() });
    else if (raw.trim() && lines.length) {
      const last = lines[lines.length - 1];
      if (last) last.text = `${last.text} ${raw.trim()}`.trim();
    }
  }
  return lines.length >= 2 ? lines : undefined;
}

/** A summary as it is kept: its profile one labeled line each, or the text as written. */
export function profileText(text: string): string {
  const lines = profileLines(text);
  return lines ? lines.map((line) => `${line.label}: ${line.text}`).join("\n") : text.trim();
}
