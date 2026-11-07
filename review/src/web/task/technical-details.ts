/** The part of a failure reason its summary does not already say, for Technical Details. */
export function taskTechnicalDetails(
  reason: string | undefined,
  summary: string | undefined,
): string | undefined {
  if (!reason) return undefined;
  const normalizedReason = reason.trim();
  if (!summary) return normalizedReason || undefined;

  const normalizedSummary = summary.trim();
  if (normalizedReason === normalizedSummary) return undefined;
  if (normalizedReason.startsWith(normalizedSummary)) {
    const remainder = normalizedReason.slice(normalizedSummary.length).trim();
    return remainder || undefined;
  }
  return normalizedReason || undefined;
}
