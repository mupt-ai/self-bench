import { useEffect, useRef } from "react";

const VERTEX = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// Ripples travelling outwards: rings centred on the page that spread away from it over time,
// as if the page had touched the water. Stronger at the window edges, calm behind the content.
// A slow angular warp keeps the rings organic; a 4x4 ordered dither turns them into grain.
const FRAGMENT = `
precision mediump float;
uniform vec2 size;
uniform float time;
uniform vec3 tint;
uniform float strength;

float height(vec2 q, float t) {
  float angle = atan(q.y, q.x);
  float r = length(q);
  r += 0.035 * sin(angle * 3.0 + t * 0.15) + 0.02 * sin(angle * 7.0 - t * 0.22);
  // Phase falls with time, so each crest moves to a larger radius: outwards.
  return sin(r * 14.0 - t * 0.9) * 0.55
       + sin(r * 23.0 - t * 1.4 + angle * 2.0) * 0.28
       + sin(r * 37.0 - t * 2.0 - angle * 3.0) * 0.14;
}
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

void main() {
  vec2 q = (gl_FragCoord.xy - 0.5 * size) / size.y;
  float t = time;
  float h = height(q, t);
  // Calm in the middle where the content sits, livelier toward the window edges.
  float edge = smoothstep(0.18, 0.75, length(q * vec2(0.8, 1.0)));
  float crest = smoothstep(0.3, 0.85, h) * (0.35 + 0.65 * edge);
  // Strictly above the threshold, so flat water draws nothing at all.
  float dot4 = step(bayer4(gl_FragCoord.xy) + 0.04, crest);
  gl_FragColor = vec4(tint, dot4 * strength);
}`;

/**
 * Faint ripples spreading out from the page. Rendered at half resolution, paused
 * when the tab is hidden, and drawn once without motion for visitors who prefer less motion.
 */
export function WaterBackground() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const gl = element?.getContext("webgl", { premultipliedAlpha: false, antialias: false });
    if (!element || !gl) return;
    const shader = (type: number, source: string) => {
      const created = gl.createShader(type);
      if (!created) return undefined;
      gl.shaderSource(created, source);
      gl.compileShader(created);
      return created;
    };
    const program = gl.createProgram();
    const vertex = shader(gl.VERTEX_SHADER, VERTEX);
    const fragment = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!program || !vertex || !fragment) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const draw = (now: number) => {
      const scale = 0.5;
      const width = Math.floor(element.clientWidth * scale);
      const height = Math.floor(element.clientHeight * scale);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
        gl.viewport(0, 0, width, height);
      }
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      gl.uniform2f(uniform("size"), width, height);
      gl.uniform1f(uniform("time"), still ? 0 : now / 1000);
      gl.uniform3f(uniform("tint"), dark ? 1 : 0.28, dark ? 1 : 0.24, dark ? 1 : 0.18);
      gl.uniform1f(uniform("strength"), dark ? 0.22 : 0.3);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!still) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    const visibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(draw);
    };
    document.addEventListener("visibilitychange", visibility);
    // A still frame only redraws on demand, so repaint it when the theme flips.
    const themeChange = new MutationObserver(() => {
      if (still) visibility();
    });
    themeChange.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
      themeChange.disconnect();
    };
  }, []);
  return <canvas ref={canvas} className="pointer-events-none fixed inset-0 -z-10 h-full w-full" />;
}
