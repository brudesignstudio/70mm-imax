/**
 * shaders.js — GLSL ES 1.00 source for the film pipeline.
 *
 * Pipeline (offscreen passes run at reduced resolution):
 *
 *   video ──┬────────────────────────────────────────────────┐
 *           │                                                │
 *           └─▶ BRIGHT ─▶ blurH ─▶ blurV ──▶ bloom ──────┐   │
 *                                    └─▶ DOWN ─▶ blurH ─▶ blurV ─▶ halation
 *                                                        │   │
 *                                                 COMPOSITE ◀┘
 *
 * COMPOSITE is where the photograph is actually made: lens
 * artefacts, optical scatter, tone transfer, colour, emulsion
 * grain, and viewing artefacts, in that order.
 *
 * Performance note: everything that is constant across a frame
 * (gate weave, breathing, grain seed) is computed on the CPU and
 * arrives as a uniform. Nothing per-frame is recomputed per-pixel.
 */

/* ===============================================================
   VERTEX — one full-screen triangle, shared by every pass.
   One triangle rather than two: no diagonal seam, and better quad
   utilisation on tiled mobile GPUs.
   =============================================================== */
export const VERT = `
attribute vec2 aPosition;
varying vec2 vUV;
void main() {
  vUV = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/* ===============================================================
   SHARED CHUNKS
   =============================================================== */

/** sRGB ⇄ linear. Scatter and tone mapping are only physically
 *  meaningful in linear light, so we decode on the way in and
 *  encode on the way out. The piecewise 2.4 form is used rather
 *  than a flat 2.2 because the linear segment near black is
 *  exactly where halation and grain live. */
const COLORSPACE = `
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** sin()-based hash: the only form that compiles identically across
 *  every mobile GPU driver we target (no integer ops in ES 1.00). */
const NOISE = `
float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
`;

/**
 * Gate transform + centre crop, shared by BRIGHT and COMPOSITE so
 * that scattered light moves *with* the frame instead of sliding
 * against it.
 *
 *   uGate.x  = 1 / breathing scale   (magnification wander)
 *   uGate.yz = lateral weave offset  (registration play)
 *   uCrop.xy = crop scale, uCrop.zw = crop offset
 *
 * Both gate terms are ~1/1000 of the frame: felt, not seen.
 */
const GATE = `
uniform vec4 uCrop;
uniform vec3 uGate;

vec2 gateUV(vec2 uv) {
  vec2 c = (uv - 0.5) * uGate.x + uGate.yz;
  return (c + 0.5) * uCrop.xy + uCrop.zw;
}
`;

/* ===============================================================
   PASS 1 — BRIGHT
   Isolates light energetic enough to scatter, in linear space,
   with a soft knee so the glow fades in rather than switching on.
   =============================================================== */
export const FRAG_BRIGHT = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uSrc;
uniform float uThreshold;
uniform float uKnee;
${COLORSPACE}
${GATE}

void main() {
  vec3 c = toLinear(texture2D(uSrc, gateUV(vUV)).rgb);
  float l = max(c.r, max(c.g, c.b));
  float k = clamp((l - uThreshold) / max(uKnee, 1e-4), 0.0, 1.0);
  k *= k;                                   // quadratic soft knee
  // Halved for 8-bit storage headroom; COMPOSITE multiplies back.
  gl_FragColor = vec4(min(c * k * 0.5, vec3(1.0)), 1.0);
}`;

/* ===============================================================
   PASS 2/3 — SEPARABLE GAUSSIAN
   A 9-tap kernel executed as 5 bilinear samples. uDir selects the
   axis so one program serves every blur in the chain.
   =============================================================== */
export const FRAG_BLUR = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uRadius;

void main() {
  vec2 o1 = uDir * uTexel * 1.3846153846 * uRadius;
  vec2 o2 = uDir * uTexel * 3.2307692308 * uRadius;
  vec3 c  = texture2D(uSrc, vUV).rgb      * 0.2270270270;
  c += texture2D(uSrc, vUV + o1).rgb      * 0.3162162162;
  c += texture2D(uSrc, vUV - o1).rgb      * 0.3162162162;
  c += texture2D(uSrc, vUV + o2).rgb      * 0.0702702703;
  c += texture2D(uSrc, vUV - o2).rgb      * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

/* ===============================================================
   PASS 4 — DOWNSAMPLE
   Feeds the wide halation chain from the finished bloom so the two
   scatter radii stay energy-consistent.
   =============================================================== */
export const FRAG_DOWN = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  vec3 c = texture2D(uSrc, vUV).rgb * 0.25;
  c += texture2D(uSrc, vUV + vec2( uTexel.x,  uTexel.y)).rgb * 0.1875;
  c += texture2D(uSrc, vUV + vec2(-uTexel.x,  uTexel.y)).rgb * 0.1875;
  c += texture2D(uSrc, vUV + vec2( uTexel.x, -uTexel.y)).rgb * 0.1875;
  c += texture2D(uSrc, vUV + vec2(-uTexel.x, -uTexel.y)).rgb * 0.1875;
  gl_FragColor = vec4(c, 1.0);
}`;

/* ===============================================================
   PASS 5 — COMPOSITE
   =============================================================== */
export const FRAG_COMPOSITE = `
precision highp float;
varying vec2 vUV;

uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform sampler2D uHalo;

uniform vec2  uSrcTexel;     // one source texel, expressed in output UV
uniform vec2  uRes;          // output resolution in pixels
uniform float uAspect;

// exposure + lens
uniform float uEV;
uniform float uAberration;
uniform float uVignette;
uniform float uVigFalloff;
uniform float uSharpen;

// scatter
uniform float uBloomStrength;
uniform float uHaloStrength;
uniform vec3  uHaloTint;

// tone (Hable parameters)
uniform vec4  uToneA;        // A shoulder, B linear, C angle, D toe
uniform vec3  uToneB;        // E toe-num, F toe-den, W white point
uniform float uContrast;
uniform float uBlack;
uniform float uShadowDensity;

// colour
uniform float uSat;
uniform float uHiDesat;
uniform vec3  uShadowTint;
uniform vec3  uHighTint;

// emulsion
uniform float uGrainStrength;
uniform float uGrainSize;
uniform float uGrainChroma;
uniform float uGrainShadow;
uniform float uGrainSeed;

uniform float uDither;

${COLORSPACE}
${NOISE}
${GATE}

/* --- Hable filmic transfer -----------------------------------
   Long toe (dense blacks that keep separation), controlled
   shoulder (highlights compress instead of clipping). */
vec3 hable(vec3 x) {
  float A = uToneA.x, B = uToneA.y, C = uToneA.z, D = uToneA.w;
  float E = uToneB.x, F = uToneB.y;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

/* --- Source sampling with lateral chromatic aberration --------
   Large-format glass separates the channels radially and only
   meaningfully in the outer third of the image circle, so the
   offset scales with r² and is exactly zero at centre. */
vec3 sampleSource(vec2 uv) {
  vec2 c = uv - 0.5;
  vec2 shift = c * dot(c, c) * uAberration * 0.02;
  return vec3(
    texture2D(uSrc, gateUV(uv + shift)).r,
    texture2D(uSrc, gateUV(uv)).g,
    texture2D(uSrc, gateUV(uv - shift)).b
  );
}

void main() {
  vec2 uv = vUV;

  /* 1 ─ LENS: sample, then unsharp for print acutance. --------- */
  vec3 srgb = sampleSource(uv);
  if (uSharpen > 0.001) {
    vec2 t = uSrcTexel;
    vec3 soft =
      (texture2D(uSrc, gateUV(uv + vec2(t.x, 0.0))).rgb +
       texture2D(uSrc, gateUV(uv - vec2(t.x, 0.0))).rgb +
       texture2D(uSrc, gateUV(uv + vec2(0.0, t.y))).rgb +
       texture2D(uSrc, gateUV(uv - vec2(0.0, t.y))).rgb) * 0.25;
    srgb += (srgb - soft) * uSharpen;
  }

  vec3 col = toLinear(max(srgb, vec3(0.0)));

  /* 2 ─ EXPOSURE, in linear light, before everything else. ----- */
  col *= exp2(uEV);

  /* 3 ─ SCATTER: bloom is in-lens and neutral; halation is
        in-emulsion, far wider, and strongly red-weighted because
        the red-sensitive layer sits closest to the reflective
        base. This is the ring around practicals that reads as
        "film" more than any other single artefact. */
  col += texture2D(uBloom, uv).rgb * 2.0 * uBloomStrength;
  col += texture2D(uHalo,  uv).rgb * 2.0 * uHaloTint * uHaloStrength;

  /* 4 ─ TONE: filmic transfer normalised to the white point. --- */
  col = hable(col * 2.0) / max(hable(vec3(uToneB.z)), vec3(1e-4));

  // A little extra print contrast, applied gently so the toe and
  // shoulder shaped above survive.
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);

  // Sit the negative down onto its black point…
  col = max(col - uBlack, vec3(0.0)) / max(1.0 - uBlack, 1e-4);
  // …then return a trace of film-base density to the deepest
  // shadows, so blacks read as dense rather than crushed to zero.
  col += uShadowDensity * exp(-col * 26.0);

  /* 5 ─ COLOUR: dye-layer behaviour. Mids get richer, highlights
        desaturate toward the source's own colour, and a very small
        split tone separates the ends of the scale. */
  float l = luma(col);
  float sat = mix(uSat, mix(uSat, 1.0, uHiDesat), smoothstep(0.55, 1.0, l));
  col = mix(vec3(l), col, sat);
  col += uShadowTint * (1.0 - smoothstep(0.0, 0.55, l));
  col += uHighTint   * smoothstep(0.45, 1.0, l);

  /* 6 ─ ENCODE for viewing. ----------------------------------- */
  col = toSRGB(clamp(col, 0.0, 1.0));

  /* 7 ─ EMULSION: grain lives in density, not in signal, so its
        amplitude peaks in the mid-densities and falls away in both
        clear film and solid black. Channels are partly
        decorrelated because the three dye layers are independent.
        The seed is quantised to the projection cadence on the CPU,
        so grain re-rolls 24×/second regardless of refresh rate. */
  if (uGrainStrength > 0.0001) {
    vec2 gp = floor(uv * uRes / max(uGrainSize, 0.25));
    float n0 = hash2(gp + uGrainSeed * 1.13);
    float n1 = hash2(gp + uGrainSeed * 1.13 + 37.7);
    float n2 = hash2(gp + uGrainSeed * 1.13 + 91.3);
    vec3 n = vec3(n0, mix(n0, n1, uGrainChroma), mix(n0, n2, uGrainChroma)) - 0.5;

    float ld = luma(col);
    float amp = 1.0 - pow(abs(ld * 2.0 - 1.0), 1.6);   // bell over mid-densities
    amp *= mix(1.0, uGrainShadow, 1.0 - smoothstep(0.0, 0.18, ld));
    col += n * uGrainStrength * amp * 2.0;
  }

  /* 8 ─ VIEWING: corner falloff, then dither so the shadow ramp
        does not band on an 8-bit display or encoder. */
  vec2 vc = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = clamp(length(vc) / (0.5 * length(vec2(uAspect, 1.0))), 0.0, 1.0);
  col *= 1.0 - uVignette * pow(r, uVigFalloff);

  col += (hash2(uv * uRes + uGrainSeed) - 0.5) * (uDither / 255.0);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
