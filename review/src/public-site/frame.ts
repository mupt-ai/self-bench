/**
 * The one content width shared by the header, the page, and the footer, so their edges line
 * up with the card grid and with the ruler lines drawn at the frame's sides.
 */
export const FRAME = "mx-auto w-full max-w-6xl px-6";

/** Where the ruler lines sit: a little outside the content, so the page has a margin. */
/**
 * Rulers sit a proportional margin in from each window edge: 6% of the width, never less
 * than 24px and never more than 160px. About 115px on a 1920px screen, 90px on a laptop.
 */
export const RULER_WIDTH = "w-[calc(100%-2*clamp(24px,6vw,160px))]";

/** The header and footer span the full width between the rulers. */
export const EDGE_FRAME = "mx-auto w-[calc(100%-2*clamp(24px,6vw,160px))] px-6";

/** Raised surface for cards and panels: a firmer edge and a soft drop, not a pencil line. */
export const PANEL =
  "border-[1.5px] border-(--panel-border) bg-card shadow-[0_1px_2px_rgb(0_0_0/0.05),0_2px_8px_-2px_rgb(0_0_0/0.06)]";
