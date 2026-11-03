/**
 * A line's rows along the predecessor chain, newest first. Each row names the head it was
 * written after, so the chain, not the clock, decides which row is newest.
 */
export function chainOrder<Row extends Chained>(rows: readonly Row[]): Row[] {
  const next = new Map(rows.map((row) => [row.predecessorId ?? "", row]));
  const chain: Row[] = [];
  for (let row = next.get(""); row && chain.length < rows.length; row = next.get(row.id))
    chain.push(row);
  // The unique constraint keeps every row on the chain; any stray row is kept rather than lost.
  const onChain = new Set(chain.map((row) => row.id));
  return [...chain.reverse(), ...rows.filter((row) => !onChain.has(row.id))];
}

/** A row of an append-only line of releases. */
interface Chained {
  readonly id: string;
  readonly predecessorId?: string;
  readonly withdrawnAt?: string;
}

/** The line's newest row, withdrawn or not. A release names the head it was built on. */
export const headOf = <Row extends Chained>(rows: readonly Row[]): Row | undefined => rows[0];
/** The line's newest row not withdrawn: what the public sees. */
export const currentOf = <Row extends Chained>(rows: readonly Row[]): Row | undefined =>
  rows.find((row) => !row.withdrawnAt);
