/** The 4x4 ordered-dither (Bayer) matrix, as thresholds from 0 to 15/16. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => value / 16);

/**
 * The dither threshold for the dot at (x, y). A dot is drawn when its value (coverage,
 * heat, and so on) is above this, so a smooth value turns into an even pattern of dots.
 */
export const bayer = (x: number, y: number) => BAYER4[(y & 3) * 4 + (x & 3)] ?? 0;
