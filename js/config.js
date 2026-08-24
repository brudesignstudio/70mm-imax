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
   the shape of the picture: the shader crop, the canvas dimensions
   and the CSS gate all derive from it.

     1.43       the projected 15/70 IMAX aperture (70.41 × 49.15 mm)
                — wider than it is tall, as projected film is
     1 / 1.43   the tall gate this app used to shoot

   SHOOT_ORIENTATION is deliberately *not* derived from it any more.
   The two used to be the same question — a gate taller than it is
   wide can only be shot upright — but a wide gate does not have to
   be shot sideways. We take the wide frame as a centre band out of
   an upright phone's sensor instead, so the operator keeps holding
   the phone the way they actually hold a phone and the file still
   comes out landscape. What that costs is horizontal reach: the
   band is only as wide as the phone's short axis, so a shot frames
   tighter than the same lens held sideways would. CAPTURE below is
   sized to pay for that in resolution, and 0.5× pays for it in
   focal length.
   =============================================================== */
export const FORMAT = {
  ASPECT: 1.43,

  /** How the ratio is written in the HUD. */
  LABEL: '1.43:1',

  /**
   * Longest edge of the recorded frame, in pixels. At 1.43:1 this
   * yields 1920 × 1342 at most — comfortably inside the H.264
   * envelope phones sustain at 30fps without thermal throttling.
   */
  MAX_LONG_EDGE: 1920,

  /**
   * What we ask the sensor for, written the way an upright phone
   * reports it.
   *
   * This matters more than it used to. The gate is now a wide band
   * cropped out of an upright frame, so the *width* of the finished
   * film is the phone's short axis — whatever number lands in
   * CAPTURE.WIDTH is very nearly the export's own width, and there
   * is nothing downstream that can put back resolution the sensor
   * was never asked for. 1440 × 1920 is the 4:3-ish sensor mode
   * most phones offer: 2.8MP, only a third more than the 1080p this
   * used to request, and it also tends to be the mode that reads
   * the full sensor width rather than a 16:9 crop of it — which is
   * exactly the axis a wide gate is short of.
   *
   * Both are `ideal`. A platform that hands back a landscape track
   * instead (some Android builds do, regardless of how the phone is
   * held) still works: the crop is aspect-driven, not axis-driven.
   */
  CAPTURE: {
    WIDTH: 1440,
    HEIGHT: 1920,
  },

  /** Preview render scale relative to the recording resolution. */
  PREVIEW_SCALE: 1.0,

  /**
   * Frames per second requested from the camera and used for both
   * the raw capture and the developed encode. Capped hard at 30 —
   * not just requested as `ideal` — because every extra frame here
   * is one more frame the develop pass has to grade: half the fps
   * is roughly half the heat and half the battery draw, both for
   * the live camera (native decode/encode, so it barely matters)
   * and for developing (which does the real work).
   */
  FPS: 30,

  /**
   * IMAX runs at 24fps. The develop pass renders at FPS; CADENCE is
   * only the fallback for LOOK.grain.cadence, which now defaults to
   * FPS instead — see the note there for why quantising grain to a
   * rate the footage is not actually running at was reading as
   * stutter.
   */
  CADENCE: 24,
};

/**
 * How the phone is held. Upright, always — see the note above. This
 * is what the orientation guard enforces and what drives the CSS
 * layout, because it describes where the leftover screen is, which
 * is where the controls go.
 */
export const SHOOT_ORIENTATION = 'portrait';

/** The orientation the operator is told to rotate *to*. */
export const ROTATE_PROMPT = 'Hold your phone upright to record.';

/* ===============================================================
   FRAMING GUIDE
   ---------------------------------------------------------------
   A 1.43 gate is taller than every screen the finished film is
   likely to be shown on. The guide draws where a 16:9 camera
   pointed at the same scene would have cut — same width, less
   height — so a shot can be composed to survive the crop.

   Same width and not same height because that is the honest
   comparison: two cameras behind the same lens see the same
   horizontal field, and the wider format is the one that keeps
   more picture above and below.
   =============================================================== */
export const GUIDE = {
  /** The reference format the guide marks out. */
  ASPECT: 16 / 9,
  LABEL: '16:9',
};

/* ===============================================================
   RECORDING
   =============================================================== */
export const RECORDING = {
  /** Hard limit: a 3-minute reel. Enforced to the millisecond. */
  MAX_MS: 3 * 60 * 1000,

  /**
   * Two encodes happen per take now: a raw capture straight off the
   * sensor while shooting, and a graded re-encode during developing.
   * The raw intermediate is discarded the moment developing finishes,
   * so it can afford a generous bitrate — it only has to survive one
   * more decode, not archival. The final bitrate is what actually
   * ships. 70mm grain is high-frequency detail and eats bitrate;
   * starving the encoder turns grain into blocking.
   *
   * These are pushed as high as a modern phone's hardware encoder
   * will sustain at FORMAT.MAX_LONG_EDGE / FORMAT.FPS without
   * dropping frames — quality lever, not a frame-rate or resolution
   * one, since those two are what actually risk the stutters this
   * is meant to avoid (see FORMAT.FPS and MAX_LONG_EDGE).
   * `videoBitsPerSecond` is a target, not a guarantee — Recorder
   * already falls back to the UA's own defaults if a browser rejects
   * it outright (see Recorder.start()).
   */
  RAW_VIDEO_BPS: 30_000_000,
  VIDEO_BPS: 20_000_000,
  AUDIO_BPS: 192_000,

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
   STEADICAM
   ---------------------------------------------------------------
   Software stabilisation, applied during developing — see
   components/Stabilizer.js for how the measurement works. These are
   the head's mechanical characteristics; none of them are exposed in
   the Settings sheet, because the useful user-facing question is
   only ever "on or off" (PREFS.steady).
   =============================================================== */
export const STEADY = {
  /**
   * Overscan. The frame can only slide sideways into margin that was
   * cropped away for the purpose, so a stabilised take is this much
   * tighter than an unstabilised one. 1.08 buys ±4% of the frame in
   * each direction, which covers handheld walking; going much past
   * that costs visible reach for shake nobody was complaining about.
   */
  crop: 1.08,

  /**
   * Long edge of the thumbnail motion is measured on. Small on
   * purpose: global translation is a low-frequency signal, and every
   * pixel here is paid for once per frame on the main thread, in the
   * middle of the develop pass's frame budget.
   */
  analyzeLongEdge: 128,

  /** Largest per-frame shift searched for, in analysis pixels. */
  search: 12,

  /** Sample every Nth pixel when scoring a candidate shift. */
  stride: 2,

  /**
   * Smoothing time constant, in seconds. This is the whole feel of
   * the head: it is the boundary between "the operator meant this"
   * and "the operator's hands did this". Lower follows deliberate
   * moves more crisply and leaves more shake in; higher glides more
   * and lags a fast whip pan. ~0.4s is a fluid tripod head.
   */
  tau: 0.42,

  /**
   * Where the head starts to give way, as a fraction of the slide
   * budget, and how much of the correction it hands back per frame
   * once it is fully against the stop. Together these are what stop
   * a sustained pan from spending the entire budget and leaving
   * nothing for the shake riding on top of it — below softLimit
   * they do nothing at all.
   */
  softLimit: 0.6,
  release: 0.25,

  /**
   * A shift of two analysis pixels or more has to beat "nothing
   * moved" by at least this ratio to be believed. Smaller shifts are
   * exempt: genuine handheld tremor is often worth less than a whole
   * pixel here, and its honest score sits just under the score for
   * standing still.
   */
  confidence: 0.97,

  /**
   * Mean per-pixel luma difference, 0…255, past which two frames are
   * taken not to be of the same thing at all — a cut, or motion so
   * fast the frames no longer overlap. Consecutive frames of real
   * footage sit far below this even during a brisk pan.
   */
  maxResidual: 42,
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

  /* --- Shutter -------------------------------------------------
     A cine camera's rotating shutter is open for half of each frame
     interval — a 180° angle — so every frame carries about 1/60s of
     motion smeared into it at 30fps. A phone sensor in daylight
     exposes for a thousandth of a second and hands back thirty
     razor-sharp, completely disconnected stills a second, which is
     exactly why phone video reads as "a lot of photographs" rather
     than as movement. This is the single biggest difference between
     video motion and film motion, and it is not a resolution or a
     frame-rate problem.

     We cannot lengthen the exposure after the fact, but we can
     reconstruct the integral: the develop pass carries the previous
     frame alongside the current one and mixes them in linear light.
     A shutter open for a fraction e of the frame interval integrates
     over a window whose centroid sits e/2 of the way back toward the
     previous frame, so that fraction is the mix weight — 180° gives
     0.25. The blend happens *after* stabilisation, using the previous
     frame's own gate transform, so it smears real subject motion
     rather than doubling up hand shake.

     What this cannot do is *smear*. A real shutter integrates
     continuously; two frames give us two samples, so what actually
     lands is the previous picture as a discrete ghost one whole
     frame (33ms) back, at the mix weight. At 180° that weight is
     0.25, and on anything moving quickly through the frame a
     quarter-strength copy displaced by a full frame does not read
     as motion blur — it reads as a double image, as if the frames
     could not keep up. That is why the default sits at 90° now
     rather than the cine-standard 180: half the weight, half as
     visible a second copy, and still enough integration that
     movement is not the run of frozen stills a phone sensor hands
     back. Take it to 180 for the full effect on slower subjects;
     take it to 0 for the sensor's own razor-sharp frames.

       0    electronic shutter — every frame frozen
       90   two samples' worth of integration without the ghost
       180  the cine standard; the strongest double image
       360  open shutter; heavy smear, rarely wanted */
  shutter: {
    angle: 90,         // degrees, 0…360
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

    /**
     * How many times a second the grain pattern re-rolls.
     *
     * This used to be a flat 24 — the projection cadence — while the
     * footage itself runs at FORMAT.FPS (30). Those two rates beat
     * against each other: 30 ÷ 24 is 1.25, so the grain holds still
     * for two consecutive frames once every four, and a frozen grain
     * pattern over a moving picture is read as a *duplicated frame*.
     * That 6Hz stutter on top of otherwise smooth motion was a real
     * part of why developed takes looked like a series of stills.
     *
     * Locked to the frame rate, the grain changes on every frame and
     * the beat disappears. Set it to 24 if you want the projected
     * cadence back and are willing to live with the pulse.
     */
    cadence: FORMAT.FPS,
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
   EXPORT FRAME
   ---------------------------------------------------------------
   The saved file isn't just the graded gate — it's the artwork in
   assets/film-strip.png, full-bleed, with the graded picture
   composited into a cutout ("the gate window") inside it. Baked
   into the pixels once, during developing, so it's identical in the
   in-app player, the gallery, and whatever lands in Photos.

   Unlike a live-recorded clip, this is deliberately built for how it
   gets watched after saving: full-screen, vertically, on a phone.
   The artwork is authored at exactly that shape (900 × 1600 — 9:16,
   matching SAVE.ASPECT) with the IMAX gate's own 1.43:1 window sized
   and placed inside it, branding filling what would otherwise be
   plain letterbox space above and below. The gate window is the only
   part of the artwork ever painted over; everything outside it —
   logo, sprockets, the camera graphic — comes through into the
   saved file untouched.
   =============================================================== */
export const EXPORT_FRAME = {
  /** Full-frame artwork. Not a border — the whole canvas, gate
   *  window included. The video is composited into the gate at its
   *  own native size, never cropped or stretched to fit, so the
   *  saved file is the graded take at full resolution sitting inside
   *  the artwork's frame. */
  image: 'assets/film-strip.png',

  /** Pixel geometry of that artwork, and the gate window cut into
   *  it. Read as *proportions* of the artwork's own size, not as
   *  absolute pixels — the loader scales them by the image's real
   *  natural size, so re-exporting the same layout at any resolution
   *  needs no change here. Only re-measure if the gate moves or
   *  resizes relative to the frame around it.
   *
   *  Reference layout (assets/film-strip.png):
   *     900 × 1600   whole frame (9:16)
   *       0 …  485   top margin      — logo
   *     486 … 1114   gate window     (900 × 629 — 1.43:1, never
   *                  drawn; the graded frame goes here)
   *    1115 … 1599   bottom margin   — camera graphic
   */
  imageWidth: 900,
  imageHeight: 1600,
  gate: { x: 0, y: 486, width: 900, height: 629 },
};

/* ===============================================================
   SAVE
   ---------------------------------------------------------------
   The shape of the *file itself* — separate from FORMAT.ASPECT,
   which is the shape of the picture inside it. The picture is wide
   (1.43:1) so it looks like real IMAX; the container is vertical so
   the file opens right-way-up on a phone, in Photos and in any
   vertical-video feed, with no rotation needed to watch it. The
   strip (picture + sprocket bars) is centred in the middle at full
   native resolution — nothing about the picture is scaled down to
   make room — with plain black letterboxing filling the rest.

   9:16 rather than the raw sensor's own 3:4 (FORMAT.CAPTURE) because
   9:16 is the shape every vertical-video surface actually expects —
   Photos, Reels, Shorts, TikTok, iMessage — so the file fills the
   screen instead of pillarboxing a second time inside whatever plays
   it back.
   =============================================================== */
export const SAVE = {
  ASPECT: 9 / 16,
};

/**
 * The finished aspect ratio (width ÷ height) of a developed take —
 * the whole saved file, letterboxing included. This is what a take
 * actually measures as once encoded, so it is SAVE.ASPECT, not a
 * measurement of the picture or the strip inside it. Mirrored as
 * --export-aspect in main.css for the playback frame and the
 * gallery thumbnails.
 */
export const EXPORT_ASPECT = SAVE.ASPECT;

/* ===============================================================
   ZOOM
   =============================================================== */
export const ZOOM = {
  levels: [0.5, 1, 2],
  default: 1,
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
  /** Steadicam on by default — see STEADY. */
  steady: true,
  /** The 16:9 framing guide — see GUIDE. Off by default: it is an
   *  aid for a shot you already know will be re-cropped, not
   *  furniture the viewfinder should always carry. */
  guide: false,
};
