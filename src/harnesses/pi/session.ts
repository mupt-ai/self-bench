/** Last assistant text in a pi session, for surfacing an agent's explanation when it submits nothing. */
export function finalAssistantMessage(bytes: Uint8Array): string | undefined {
  const lines = Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines.reverse()) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const message = (entry as { type?: unknown; message?: unknown }).message;
    if (
      (entry as { type?: unknown }).type !== "message" ||
      typeof message !== "object" ||
      message === null ||
      (message as { role?: unknown }).role !== "assistant"
    ) {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                typeof part === "object" &&
                part !== null &&
                typeof (part as { text?: unknown }).text === "string"
                  ? (part as { text: string }).text
                  : "",
              )
              .join("")
          : "";
    if (text.trim()) {
      return text.trim();
    }
  }
  return undefined;
}

/**
 * The provider error that ended the session, when pi's last assistant message stopped with
 * `stopReason: "error"` (pi still exits 0 in print mode, so the wrapper cannot tell).
 */
export function sessionProviderError(bytes: Uint8Array): string | undefined {
  const lines = Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines.reverse()) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const message = (entry as { type?: unknown; message?: unknown }).message;
    if (
      (entry as { type?: unknown }).type !== "message" ||
      typeof message !== "object" ||
      message === null ||
      (message as { role?: unknown }).role !== "assistant"
    ) {
      continue;
    }
    const { stopReason, errorMessage } = message as {
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (stopReason !== "error") {
      return undefined;
    }
    return typeof errorMessage === "string" && errorMessage.trim()
      ? errorMessage.trim()
      : "provider error";
  }
  return undefined;
}
