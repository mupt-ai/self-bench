/**
 * An arrow in a circle for the repository card's hover state: the ring draws, then the arrow
 * draws tail to tip. Drawn at exactly its 20-unit viewBox size so the ring sits on whole
 * pixels and stays round. It starts only after the stars have gone and vanishes before they come
 * back. The `card-on` classes hold the hover-in timing, the plain classes the hover-out timing.
 */
export function CircledArrow() {
  const draw =
    "[stroke-dasharray:1] [stroke-dashoffset:1] transition-[stroke-dashoffset] delay-100 duration-0 card-on:[stroke-dashoffset:0] card-on:ease-out";
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-5 opacity-0 transition-opacity delay-0 duration-90 card-on:opacity-100 card-on:delay-70 card-on:duration-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r="9"
        pathLength={1}
        // Flat caps, so the stroke's start and end meet without a bump.
        strokeLinecap="butt"
        transform="rotate(180 10 10)"
        className={`${draw} card-on:delay-70 card-on:duration-220`}
      />
      <path
        d="M5.5 10 H14"
        pathLength={1}
        className={`${draw} card-on:delay-130 card-on:duration-140`}
      />
      <path
        d="M10.5 6.5 L14 10 L10.5 13.5"
        pathLength={1}
        className={`${draw} card-on:delay-220 card-on:duration-110`}
      />
    </svg>
  );
}
