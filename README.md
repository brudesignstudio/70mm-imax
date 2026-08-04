# 70MM — Large Format Camera

A mobile-first PWA that shoots on a digital emulation of 70mm large-format
negative. Tall 1:1.43 gate, three minutes to a magazine, no libraries.

Built with plain HTML, CSS and ES modules. No build step — serve the folder.

---

## Running it

```bash
python3 -m http.server 8127 --directory imax-project
```

Then open `http://localhost:8127`.

**To test on a phone you need HTTPS.** `getUserMedia()` is gated behind a
secure context, and `http://192.168.x.x` is not one. Either tunnel it:

```bash
npx localtunnel --port 8127
```

…or serve with a self-signed certificate. `localhost` is exempt, so desktop
testing works over plain HTTP.

---

## Structure

```
imax-project/
├── index.html                  five screens, one document
├── manifest.webmanifest        PWA install (fullscreen, portrait)
├── sw.js                       precached app shell → works offline
├── css/
│   ├── reset.css
│   └── main.css
├── assets/icons/               generated PNG icons (192, 512, maskable)
└── js/
    ├── config.js               ← every tunable number in the app
    ├── main.js                 app controller + state machine
    ├── shaders/shaders.js      GLSL ES 1.00 for the film pipeline
    ├── components/
    │   ├── CameraManager.js    getUserMedia, lens selection, manual control
    │   ├── FilmRenderer.js     the optical bench (WebGL)
    │   ├── Recorder.js         MediaRecorder over canvas.captureStream()
    │   ├── OrientationGuard.js orientation enforcement
    │   ├── GateFit.js          exact gate sizing, in pixels
    │   ├── Histogram.js        live RGB + luminance parade
    │   ├── Playback.js         review transport
    │   ├── Gallery.js          IndexedDB shelf
    │   └── Settings.js         the "Stock & Lab" sheet
    └── utils/                  dom, format, storage, share, haptics,
                                capabilities, webgl
```

---

## How the image is made

The camera never reaches the screen directly. Every frame goes through a
WebGL pipeline and lands on a canvas that is **both the viewfinder and the
recording source** — `canvas.captureStream()` is what `MediaRecorder`
encodes. There is no export-time re-grade and no chance of the preview and
the file drifting apart.

```
video ──┬───────────────────────────────────────────────┐
        │                                               │
        └─▶ BRIGHT ─▶ blurH ─▶ blurV ──▶ bloom ─────┐   │
                            └─▶ DOWN ─▶ blurH ─▶ blurV ─▶ halation
                                                    │   │
                                             COMPOSITE ◀┘
```

`COMPOSITE` runs the chain in the order a real imaging system does:

| Stage | What it models |
|---|---|
| Chromatic aberration | radial `r²` channel separation, zero at centre |
| Unsharp | contact-print acutance |
| → linear light | scatter and tone are only meaningful in linear |
| Exposure | a stop, applied where a stop belongs |
| Bloom | neutral in-lens flare around speculars |
| Halation | red-weighted scatter off the film base — the Nolan ring |
| Hable transfer | long toe, soft shoulder, normalised to a white point |
| Black point + base density | dense blacks that never clip to zero |
| Colour | mid saturation up, highlights desaturating, tiny split tone |
| → sRGB | encode for viewing |
| Grain | amplitude peaks in the **mid-densities**, per-channel decorrelated, re-rolled at 24fps |
| Vignette + dither | corner falloff, then 8-bit banding defeated |

Gate weave and breathing are applied as a shared UV transform so scattered
light moves *with* the frame instead of sliding against it. Everything
constant per frame — weave offset, breathing scale, grain seed — is computed
on the CPU and passed as a uniform; the shaders do no work that could have
been hoisted.

Two details that do most of the "this looks like film" work:

- **Grain lives in density, not in signal.** Clear film and solid black are
  nearly grainless; the mids carry it. Uniform noise over the whole frame is
  what makes digital grain read as a filter.
- **Grain is quantised to 24fps.** It must *hold* for a whole frame. Re-rolling
  it every 60Hz refresh is exactly what video noise does.

All of it is in `LOOK` in [`js/config.js`](js/config.js), and every value is a
live slider in the Settings sheet. Overrides are stored sparsely — only what
you changed — so revisions to the reference negative still reach you.

---

## Format and limits

- **Gate:** 1:1.43 — taller than it is wide — centre-cropped from the sensor
  and enforced in the shader, the canvas dimensions, and the CSS box. From a
  1080×1920 portrait sensor frame that yields **1080×1544**: full sensor
  width, ~19.6% cropped off the height. Even pixel dimensions throughout,
  because hardware H.264 encoders need macroblock alignment.

  `FORMAT.ASPECT` in [`js/config.js`](js/config.js) is the single source of
  truth. It drives the shader crop, the canvas size, the CSS gate, which way
  the phone must be held, the rail layout, and the manifest orientation. Set
  it above 1 and the whole app flips to a landscape gate; nothing else needs
  to change.

  > A note on the number: the *projected* 15/70 IMAX aperture is
  > 70.41 × 49.15 mm — **1.43:1**, wider than it is tall. This app
  > deliberately uses the inverse, `1:1.43`, for a portrait frame.
- **Recording:** capped at exactly 3:00. Enforced twice — a timer *and* a
  per-frame check, because mobile browsers throttle timers in backgrounded
  tabs and only the tick actually guarantees the ceiling.
- **Container:** MP4/H.264 where available (Safari, recent Chrome), WebM
  otherwise. MP4 is tried first everywhere because it is the only container
  iOS will save into Photos.
- **Bitrate:** 12 Mbps. Grain is high-frequency detail; starving the encoder
  turns it into blocking.

---

## Browser limitations, and what is done instead

These are real gaps in the web platform, not shortcuts. Each is detected at
runtime — never sniffed from the user agent — and reported on the intro
screen before you shoot.

| Feature | Chrome / Android | iOS Safari | Fallback |
|---|---|---|---|
| Camera, WebGL, MediaRecorder | ✅ | ✅ | — |
| Save to Photos | via share sheet | via share sheet, **MP4 only** | `<a download>` → Files |
| Tap to focus | ✅ `pointsOfInterest` | ❌ not implemented | reticle still confirms the tap; camera stays on continuous AF |
| Exposure lock / WB lock | ✅ where the device reports it | ❌ | control is hidden rather than shown doing nothing |
| Exposure compensation | ✅ sensor-level | ❌ | same value applied as linear-light gain *before* the tone curve, so it rolls through the shoulder instead of clipping |
| Flash | ✅ `torch` constraint | ❌ no API at all | button stays visible, struck through, and says why |
| Haptics | ✅ `navigator.vibrate` | ❌ no API reaches the Taptic Engine | one-frame luminance pulse on the gate — a tally, which is what the haptic was for |
| Orientation lock | ✅ (requires fullscreen) | ❌ | guard stays live; rotating mid-take stops the take cleanly |
| Fullscreen | ✅ | ❌ for non-`<video>` elements | install to Home Screen — the manifest requests fullscreen |
| Wake lock | ✅ | ✅ 16.4+ | screen may dim on older iOS |

There is no web API for a photographic flash — `torch` is a continuous lamp.
That happens to be the right thing for a movie camera anyway.

---

## Notes on a few decisions

**Why the orientation requirement is derived, not hard-coded.** The gate's
shape decides which way the phone has to be held, so `GATE_ORIENTATION` is
computed from `FORMAT.ASPECT` and handed to `OrientationGuard`. The layout
follows the same signal: rails sit on the letterbox bars, which means side
rails for a wide gate and top/bottom bars for a tall one. Nothing in the CSS
or the guard assumes landscape.

**Why the encoder cap is on the long edge.** Capping *width* at 1920 would
make a 1:1.43 frame 1920 × 2746 — 5.3 megapixels, well past what mobile
hardware encoders sustain. `MAX_LONG_EDGE` caps whichever edge is longer, so
the portrait gate lands at 1342 × 1920 at most.

**Why the gate is sized in JavaScript.** The obvious CSS answer,
`aspect-ratio` plus `vh`, is wrong on phones: `100vh` on iOS is the *large*
viewport, so the gate is oversized while the URL bar is visible and jumps as
it collapses. `dvh` fixes the height but still cannot express "fit a 1.43:1
box inside this box", because a width calculation cannot reference the
parent's resolved height. A `ResizeObserver` gives both dimensions at once.

**Why orientation is detected from the viewport.** `screen.orientation` looks
authoritative and describes the *device*, not the window — it reports
`landscape-primary` in iPad Split View, Stage Manager, and embedded web views
while the page is taller than it is wide. The gate has to fit the viewport.

**Why `destroy()` does not call `loseContext()`.** A canvas only ever hands
out one WebGL context. Losing it deliberately makes the viewfinder
unrecoverable for the life of the page — including on the
`webglcontextrestored` path, which is precisely when a rebuild is needed.

**Why recording stops when the app is backgrounded.** The OS suspends the
camera; a take that continued would record frozen frames.

---

## Stretch goals

Implemented: orientation lock, haptics (with fallback), fullscreen, PWA
install, offline after install, live histogram, tap-to-focus reticle,
exposure lock, white balance lock, manual exposure compensation, flash,
wake lock, and an IndexedDB gallery that survives reloads.
