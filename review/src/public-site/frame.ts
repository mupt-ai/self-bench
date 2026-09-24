/*
 * The frame's classes. Their measurements are CSS variables (theme.css), narrowed for compact
 * screens in one place (mobile/mobile.css), so everything built on them adapts on its own.
 */

/**
 * The one content width shared by the header, the page, and the footer, so their edges line
 * up with the card grid and with the ruler lines drawn at the frame's sides.
 */
export const FRAME = "mx-auto w-full max-w-6xl px-(--gutter)";

/**
 * Where the ruler lines sit: `--edge` in from each window side, a proportional margin on
 * large screens (6% of the width, 24px to 160px) and close to the edges on a phone.
 */
export const RULER_WIDTH = "w-[calc(100%-2*var(--edge))]";

/** The header and footer span the full width between the rulers. */
export const EDGE_FRAME = "mx-auto w-[calc(100%-2*var(--edge))] px-(--bar-inset)";

/** Raised surface for cards and panels: a firmer edge and a soft drop, not a pencil line. */
export const PANEL =
  "border-[1.5px] border-(--panel-border) bg-card shadow-[0_1px_2px_rgb(0_0_0/0.05),0_2px_8px_-2px_rgb(0_0_0/0.06)]";
