/**
 * config.js
 * ---------------------------------------------------------------
 * Every tunable number in the app lives here.
 *
 * The film look is deliberately expressed as *photographic*
 * quantities (density, halation, grain index) rather than as
 * "filter strength", so that dialling one value does something
 * physically plausible instead of something arbitrary.
 *
 * All look values are also exposed in the Settings sheet, which
 * writes overrides into localStorage. LOOK below is the reference
 * negative — the "70mm default" that Reset restores.
 */

/* ===============================================================
   FORMAT
   ---------------------------------------------------------------
   ASPECT is width ÷ height and is the single source of truth for
   the whole app: the shader crop, the canvas dimensions, the CSS
   gate, which way the phone must be held, and the orientation the
   manifest asks for all derive from it.

   Set it above 1 for a landscape gate, below 1 for a portrait one.
   Nothing else needs to change.

     1 / 1.43   tall gate  (current — portrait)
     1.43       wide gate  (the projected 15/70 IMAX aperture,
                            70.41 × 49.15 mm)
   =============================================================== */
export const FORMAT = {
  ASPECT: 1 / 1.43,

  /** How the ratio is written in the HUD. */
  LABEL: '1:1.43',

  /**
   * Longest edge of the recorded frame, in pixels — the *long*
   * edge, not the width, so a portrait gate does not end up 1920 ×
   * 2746 and blow past what mobile hardware encoders accept. At
   * 1:1.43 this yields 1342 × 1920, a shade over 1080p portrait in
   * pixel count and comfortably inside the H.264 envelope phones
   * sustain at 30fps without thermal throttling.
   */
  MAX_LONG_EDGE: 1920,

  /** Preview render scale relative to the recording resolution. */
  PREVIEW_SCALE: 1.0,

  /** Frames per second requested from the camera and the encoder. */
  FPS: 30,

  /**
   * IMAX runs at 24fps. Rendering at 24 would make the preview feel
   * broken on a 60Hz phone, so we render at display rate and only
   * quantise the *grain* to CADENCE (see LOOK.grain.cadence).
   */
  CADENCE: 24,
};

/**
 * The device orientation the gate requires. A frame taller than it
 * is wide can only be shot with the phone held upright.
 */
export const GATE_ORIENTATION = FORMAT.ASPECT >= 1 ? 'landscape' : 'portrait';

/** The orientation the operator is told to rotate *to*. */
export const ROTATE_PROMPT =
  `Rotate your phone to ${GATE_ORIENTATION} to record.`;

/* ===============================================================
   RECORDING
   =============================================================== */
export const RECORDING = {
  /** Hard limit: a 3-minute magazine. Enforced to the millisecond. */
  MAX_MS: 3 * 60 * 1000,

  /** Target bitrates. 70mm grain is high-frequency detail and eats
   *  bitrate; starving the encoder turns grain into blocking. */
  VIDEO_BPS: 12_000_000,
  AUDIO_BPS: 128_000,

  /** MediaRecorder chunk interval. */
  TIMESLICE_MS: 1000,

  /**
   * Container preference. Safari can only *save to Photos* from an
   * MP4, so MP4 is tried first everywhere; WebM is the Chrome/Firefox
   * fallback and is download-only on iOS.
   */
  MIME_CANDIDATES: [
    'video/mp4;codecs=avc1.640029,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ],
};

/* ===============================================================
   THE LOOK
   ---------------------------------------------------------------
   Ordering matters and mirrors a real imaging chain:
     capture → lens → optical print artefacts → tone → colour →
     emulsion (grain) → gate mechanics → viewing
   =============================================================== */
export const LOOK = {

  /* --- Exposure ------------------------------------------------
     Digital exposure trim, applied in linear light before the tone
     curve. Used as a fallback on browsers that will not expose the
     hardware exposureCompensation constraint (i.e. iOS Safari). */
  exposure: {
    ev: 0.0,          // −2 … +2 stops
  },

  /* --- Lens ----------------------------------------------------
     Large-format glass is clean; what betrays it is a whisper of
     lateral chromatic aberration at the extreme corners and a
     touch of falloff. Both stay near the threshold of perception. */
  lens: {
    aberration: 0.28,   // radial R/B separation, ~0.6px at the corner
    vignette: 0.16,     // corner falloff (0 = none)
    vignetteFalloff: 2.6,
  },

  /* --- Bloom ---------------------------------------------------
     Light scattering *inside the lens*: a tight, neutral glow that
     lifts specular highlights without fogging the image. */
  bloom: {
    strength: 0.20,
    threshold: 0.72,    // linear luminance where the glow begins
    knee: 0.28,         // soft shoulder into the threshold
    radius: 1.0,        // blur scale multiplier
  },

  /* --- Halation ------------------------------------------------
     The signature of film, not of lenses: bright light passes
     through the emulsion, reflects off the base, and re-exposes
     the layers from beneath. Red records it most, blue least —
     hence the warm ring around practicals in Nolan photography. */
  halation: {
    strength: 0.30,
    radius: 1.0,
    tint: [1.0, 0.42, 0.20], // R, G, B response of the scattered light
  },

  /* --- Tone ----------------------------------------------------
     A Hable/filmic transfer: long toe, gentle shoulder. Blacks get
     dense but never clip to zero, highlights roll instead of
     clamping. Defaults approximate a Vision3 print curve. */
  tone: {
    contrast: 0.16,        // extra S applied after the curve
    shoulder: 0.22,        // A — highlight rolloff strength
    linearStrength: 0.30,  // B
    linearAngle: 0.10,     // C
    toe: 0.20,             // D — shadow toe
    toeNumerator: 0.01,    // E
    toeDenominator: 0.30,  // F
    whitePoint: 11.2,      // linear value mapped to display white
    blackPoint: 0.018,     // where the negative sits down
    shadowDensity: 0.012,  // film-base density: keeps blacks off 0.0
  },

  /* --- Colour --------------------------------------------------
     "Richness" without a colour cast: saturation is lifted in the
     mids and pulled back in the highlights the way dye layers
     actually behave, plus a very small split tone. */
  color: {
    saturation: 1.12,
    highlightDesat: 0.34,     // how much saturation the highlights lose
    shadowTint: [-0.006, 0.000, 0.012],  // cool, teal-ward shadows
    highlightTint: [0.010, 0.004, -0.008], // warm highlights
  },

  /* --- Grain ---------------------------------------------------
     65mm negative has a far finer grain *relative to the frame*
     than 35mm, because the frame is ~10× the area. So: small
     amplitude, fine structure, and strongest in the mid-densities
     — clear film and solid black are both nearly grainless. */
  grain: {
    strength: 0.055,
    size: 1.35,        // grain cell size in output pixels
    chroma: 0.35,      // how decorrelated the R/G/B grain is
    shadowBias: 0.55,  // grain retained in the shadows
    cadence: 24,       // grain re-rolls at 24fps, not at refresh rate
  },

  /* --- Gate mechanics ------------------------------------------
     The negative is registered by pins but still moves a few
     microns. Weave is lateral, breathing is scale. Both are
     ~1/2000 of the frame — you feel them, you don't see them. */
  gate: {
    weave: 0.0011,     // fraction of frame width
    weaveSpeed: 0.55,
    breathing: 0.0016, // fractional scale oscillation
    breathingSpeed: 0.28,
    /** Gate movement during *live preview* is disorienting when you
     *  are trying to frame a shot, so it is off by default there
     *  and on during playback. */
    livePreview: false,
  },

  /* --- Print / viewing -----------------------------------------
     A touch of unsharp to mimic the acutance of a contact print,
     and dithering so 8-bit output does not band in the shadows. */
  print: {
    sharpen: 0.30,
    dither: 1.0,
  },
};

/* ===============================================================
   QUALITY TIERS
   Halation is the most expensive pass (two extra blurs). Dropping
   to "standard" keeps the grade and grain and loses only the
   widest scatter — the frame still reads as film.
   =============================================================== */
export const QUALITY = {
  high:     { bloom: true,  halation: true,  bloomDiv: 2, haloDiv: 8 },
  standard: { bloom: true,  halation: false, bloomDiv: 4, haloDiv: 8 },
  low:      { bloom: false, halation: false, bloomDiv: 4, haloDiv: 8 },
};

/* ===============================================================
   STORAGE KEYS
   =============================================================== */
export const STORAGE = {
  LOOK_KEY: 'imax70.look.v1',
  PREFS_KEY: 'imax70.prefs.v1',
  DB_NAME: 'imax70',
  DB_STORE: 'takes',
  DB_VERSION: 1,
};

/* ===============================================================
   DEFAULT USER PREFERENCES
   =============================================================== */
export const PREFS = {
  quality: 'high',
  histogram: true,
  haptics: true,
  gateWeaveLive: false,
  audio: true,
};
