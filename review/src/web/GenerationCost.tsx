import type { GenerationCost as GenerationCostValue } from "../../../src/contracts/index";

export function GenerationCost({ cost }: { cost: GenerationCostValue | undefined }) {
  const value = costLabel(cost);
  return (
    <span className="text-xs text-muted-foreground">
      Current Cost: <span className="tabular-nums text-foreground">{value}</span>
    </span>
  );
}

export function costLabel(cost: GenerationCostValue | undefined): string {
  if (!cost || cost.state === "unknown") return "Unknown";
  if (cost.state === "unpriced") return "Unpriced by Provider";
  if (cost.state === "partial") {
    const known = [cost.modelUsd, cost.sandboxUsd].reduce<number | undefined>(
      (total, value) => (value === undefined ? total : (total ?? 0) + value),
      undefined,
    );
    return known === undefined ? "Partially Priced" : `${dollars(known)}+ (Partial)`;
  }
  return dollars(cost.usd ?? 0);
}

function dollars(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
