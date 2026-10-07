/**
 * The Results chart before there is anything on it: its axes, and hollow points along a dashed
 * frontier where models will land by accuracy and cost per task. Drawn in the faint ink, so it
 * reads as a promise of the page, not as data.
 */
export function GhostChart() {
  const frontier = [
    [62, 176],
    [104, 136],
    [162, 100],
    [246, 74],
    [348, 56],
  ] as const;
  const others = [
    [142, 158],
    [222, 124],
    [302, 102],
  ] as const;
  return (
    <svg viewBox="0 0 380 250" className="block h-auto w-full" fill="none" role="presentation">
      <g stroke="var(--ruler)">
        <path d="M44 20h326M44 70h326M44 120h326M44 170h326" />
        <path d="M115 20v200M187 20v200M259 20v200M331 20v200" />
      </g>
      <path d="M44 20v200h326" stroke="var(--border)" strokeWidth="1.5" />
      <path
        d={`M${frontier.map(([x, y]) => `${x} ${y}`).join(" L")}`}
        stroke="var(--faint)"
        strokeDasharray="4 5"
        strokeWidth="1.5"
      />
      <g stroke="var(--faint)" strokeWidth="1.5">
        {frontier.map(([x, y]) => (
          <circle key={x} cx={x} cy={y} r="6" />
        ))}
        {others.map(([x, y]) => (
          <circle key={x} cx={x} cy={y} r="5" opacity="0.5" />
        ))}
      </g>
      <g fill="var(--faint)" fontSize="12" fontFamily="var(--sans)">
        <text x="40" y="24" textAnchor="end">
          100%
        </text>
        <text x="40" y="224" textAnchor="end">
          0%
        </text>
        <text x="44" y="244">
          $0
        </text>
        <text x="370" y="244" textAnchor="end">
          Cost / Task
        </text>
        <text transform="rotate(-90 14 120)" x="14" y="120" textAnchor="middle">
          Accuracy
        </text>
      </g>
    </svg>
  );
}
