/** Lowercased words of `text`, split at spaces and the punctuation names and ids use. */
function searchWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s·()/.:_-]+/)
    .filter(Boolean);
}

/** Whether each word of `query` starts a word of `text`, so "pi" finds Pi but not "API Key". */
export function matchesQuery(text: string, query: string): boolean {
  const words = searchWords(text);
  return searchWords(query).every((word) => words.some((part) => part.startsWith(word)));
}
