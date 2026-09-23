/**
 * Resolves any CSS colour, including var() and color-mix() on the theme tokens, to RGB that
 * canvas pixel code can use. Reads it through a probe element, then through a canvas.
 */
export function resolveRgb(value: string): [number, number, number] {
  const element = document.createElement("span");
  element.style.color = value;
  document.documentElement.append(element);
  const resolved = getComputedStyle(element).color;
  element.remove();
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return [0, 0, 0];
  probe.fillStyle = resolved;
  probe.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = probe.getImageData(0, 0, 1, 1).data;
  return [red, green, blue];
}
