import { useEffect, useRef } from "react";
import { motionOff } from "../motion";

const VERTEX = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// Three water surfaces, all drawn as a 4x4 ordered dither so they read as grain, not blur.
//   mode 0: rings centred on the page spreading outwards, as if the page had touched the water.
//   mode 1: the same rings travelling inwards.
//   mode 2: sparse raindrops landing at random, each ring widening and fading.
// Every mode is calm behind the content and livelier toward the window edges.
const FRAGMENT = `
precision mediump float;
uniform vec2 size;
uniform float time;
uniform vec3 tint;
uniform float strength;
uniform float mode;
uniform float coverage;

float hash(float n) { return fract(sin(n) * 43758.5453); }

float rings(vec2 q, float t, float direction) {
  float angle = atan(q.y, q.x);
  float r = length(q);
  r += 0.035 * sin(angle * 3.0 + t * 0.15) + 0.02 * sin(angle * 7.0 - t * 0.22);
  // With direction -1 the phase falls over time and each crest moves to a larger radius.
  float s = direction * t;
  float h = sin(r * 14.0 + s * 0.9) * 0.55
          + sin(r * 23.0 + s * 1.4 + angle * 2.0) * 0.28
          + sin(r * 37.0 + s * 2.0 - angle * 3.0) * 0.14;
  return smoothstep(0.3, 0.85, h);
}

float rain(vec2 q, float t) {
  float aspect = size.x / size.y;
  float shade = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float period = 4.0 + hash(fi * 7.13) * 3.0;
    float phase = t / period + hash(fi * 3.31);
    float drop = floor(phase) * 17.0 + fi * 1.93;
    float age = fract(phase);
    vec2 centre = (vec2(hash(drop * 1.7), hash(drop * 2.9)) - 0.5) * vec2(aspect, 1.0);
    float d = length(q - centre);
    float front = age * 0.55;
    // A short train of ripples just inside the widening front, fading as the drop ages.
    float train = exp(-pow((front - d) * 9.0, 2.0)) * step(d, front + 0.02);
    float crest = 0.5 + 0.5 * cos((front - d) * 80.0);
    shade += train * crest * (1.0 - age) * smoothstep(0.0, 0.04, age);
  }
  return clamp(shade, 0.0, 1.0);
}

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

void main() {
  vec2 q = (gl_FragCoord.xy - 0.5 * size) / size.y;
  float shade = mode < 1.5 ? rings(q, time, mode < 0.5 ? -1.0 : 1.0) : rain(q, time);
  float edge = smoothstep(0.18, 0.75, length(q * vec2(0.8, 1.0)));
  shade = clamp(shade * (0.35 + 0.65 * edge) * coverage, 0.0, 1.0);
  // Strictly above the threshold, so flat water draws nothing at all.
  float dot4 = step(bayer4(gl_FragCoord.xy) + 0.04, shade);
  gl_FragColor = vec4(tint, dot4 * strength);
}`;

const MODES: Record<string, number> = { out: 0, in: 1, rain: 2 };

/**
 * What the page asks of the water, read from the root element: `data-water` picks the mode
 * (out, in, rain, or off); `--ripple` is the dot colour, `--ripple-strength` its opacity,
 * `--ripple-coverage` scales how much of each wave draws dots, and `--ripple-speed` how fast
 * the water moves.
 */
function readWater(root: HTMLElement) {
  const style = getComputedStyle(root);
  const [red = 0, green = 0, blue = 0] = style
    .getPropertyValue("--ripple")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const strength = Number.parseFloat(style.getPropertyValue("--ripple-strength"));
  const coverage = Number.parseFloat(style.getPropertyValue("--ripple-coverage"));
  const speed = Number.parseFloat(style.getPropertyValue("--ripple-speed"));
  const choice = root.dataset.water ?? "out";
  return {
    tint: [red / 255, green / 255, blue / 255] as const,
    strength: Number.isFinite(strength) ? strength : 0.3,
    coverage: Number.isFinite(coverage) ? coverage : 1,
    speed: Number.isFinite(speed) ? speed : 1,
    mode: choice === "off" ? undefined : (MODES[choice] ?? 0),
  };
}

/**
 * Faint water behind the page. Rendered at half resolution, paused when the tab is hidden,
 * drawn once, still, for visitors whose system prefers less motion, and not drawn at all when
 * they turn animations off in the settings menu.
 */
export function WaterBackground({ bands = false }: { bands?: boolean }) {
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
    // No blending: one pass over a cleared canvas, so the dot opacity is written as is.
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const root = document.documentElement;
    let water = readWater(root);
    let frame = 0;
    // The water's own clock, advanced at the theme's speed, so a speed change (on a theme
    // switch) changes the pace smoothly instead of jumping to a different moment.
    let clock = 7;
    let last = 0;
    const draw = (now: number) => {
      const still = motionOff();
      if (last) clock += (Math.min(now - last, 100) / 1000) * water.speed;
      last = now;
      const scale = 0.5;
      const width = Math.floor(element.clientWidth * scale);
      const height = Math.floor(element.clientHeight * scale);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
        gl.viewport(0, 0, width, height);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Off by choice, from the widgets or the settings menu: no water at all.
      if (water.mode === undefined || root.dataset.motion === "off") return;
      gl.uniform2f(uniform("size"), width, height);
      // Starts part-way in (7s), so raindrops are already falling on the first view.
      gl.uniform1f(uniform("time"), still ? 7 : clock);
      gl.uniform3f(uniform("tint"), ...water.tint);
      gl.uniform1f(uniform("strength"), water.strength);
      gl.uniform1f(uniform("mode"), water.mode);
      gl.uniform1f(uniform("coverage"), water.coverage);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!still) frame = requestAnimationFrame(draw);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      last = 0;
      if (!document.hidden) frame = requestAnimationFrame(draw);
    };
    restart();
    // Theme, palette, and mode changes all land on the root element's attributes.
    const observer = new MutationObserver(() => {
      water = readWater(root);
      restart();
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-water", "data-motion", "style"],
    });
    document.addEventListener("visibilitychange", restart);
    // A still frame (reduced motion) is redrawn on resize, or it would stretch.
    window.addEventListener("resize", restart);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", restart);
      window.removeEventListener("resize", restart);
    };
  }, []);
  // `bands`: a second copy shown only over the pinned header and footer (whose backgrounds
  // hide the first), drawn to the same viewport, so the water runs on unbroken behind them.
  return (
    <canvas
      ref={canvas}
      className={
        bands
          ? "pointer-events-none fixed inset-0 z-[7] h-full w-full [mask-image:linear-gradient(black_0_var(--bar-top),transparent_var(--bar-top)_calc(100%-var(--bar-bottom)),black_calc(100%-var(--bar-bottom)))]"
          : "pointer-events-none fixed inset-0 -z-10 h-full w-full"
      }
    />
  );
}
