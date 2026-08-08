/**
 * Stabilizer.js
 * ---------------------------------------------------------------
 * The steadicam — a software camera head, run during developing.
 *
 * There is no stabilisation API on the web. `getUserMedia` has no
 * videoStabilizationMode constraint, and neither Chrome on Android
 * nor iOS Safari exposes the OIS/EIS the phone is doing internally,
 * so the only place this can happen is where we already have every
 * frame in our hands: the develop pass.
 *
 * How it works, in the order it happens:
 *
 *  1. MEASURE. Each raw frame is scaled down to a thumbnail a few
 *     dozen pixels on its long edge, reduced to luma, and halved
 *     again into a second, blurrier level. The shift between this
 *     frame and the previous one is found by scoring every candidate
 *     offset on the small level by sum-of-absolute-differences, then
 *     refining that answer within ±2 pixels on the larger one — a
 *     two-level pyramid, scored exhaustively at both levels, over
 *     the whole frame at once so what comes out is *global* motion
 *     rather than per-block motion.
 *
 *     Exhaustive rather than the logarithmic three-step search a
 *     codec would use, and this is not a detail: a three-step search
 *     assumes the error surface slopes toward the answer, and on
 *     fine detail — foliage, gravel, fabric, grain — it does not.
 *     It is a field of near-identical spikes, and the walk reliably
 *     ends up pinned against the edge of its search range with a
 *     confident, completely wrong answer. Searching every offset on
 *     a deliberately blurred small level cannot do that, and costs
 *     a few hundred thousand byte comparisons a frame to guarantee.
 *
 *  2. INTEGRATE. Those per-frame shifts are summed into a camera
 *     path: where the operator's hands have actually taken the frame
 *     since the take started.
 *
 *  3. SMOOTH. That path is low-passed with a time constant (STEADY.tau).
 *     Slow intent — a pan, a walk-in — passes through the filter
 *     untouched. Fast hand tremor and the vertical bounce of a
 *     footstep do not.
 *
 *  4. CORRECT. The difference between the real path and the smoothed
 *     one is how far the frame has to slide to sit on the smooth
 *     path instead. That slide is paid for out of the overscan
 *     margin (STEADY.crop) — the reason a stabilised frame is always
 *     slightly tighter than an unstabilised one, on this or on any
 *     camera that does this.
 *
 * Deliberately translation-only. Rotation would need a second search
 * dimension for a fraction of the benefit: the dominant artefact when
 * walking is vertical bounce plus pitch, and pitch reads as vertical
 * translation over anything but a very wide lens. Roll is what is
 * left on the table, and it is the smallest term.
 */

import { STEADY } from '../config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Stabilizer {
  constructor(opts = {}) {
    this.tau = opts.tau ?? STEADY.tau;
    this.searchPx = opts.search ?? STEADY.search;
    this.longEdge = opts.longEdge ?? STEADY.analyzeLongEdge;
    this.stride = opts.stride ?? STEADY.stride;

    // The analysis surface. willReadFrequently keeps it on a CPU
    // backing store: this canvas is read back every single frame,
    // and a GPU-backed one would stall the pipeline to do it.
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.aw = 0;
    this.ah = 0;

    // Two levels each of this frame and the last. L0 is the luma
    // thumbnail; L1 is L0 box-halved, which is both four times
    // cheaper to search and — because averaging is a low-pass — a
    // surface a search can actually descend.
    this.cur = null;    // Uint8Array luma, aw × ah
    this.prev = null;
    this.curL1 = null;  // Uint8Array luma, hw × hh
    this.prevL1 = null;
    this.hw = 0;
    this.hh = 0;
    this._havePrev = false;

    // Camera path and its smoothed twin, both in analysis pixels.
    this.pathX = 0;
    this.pathY = 0;
    this.smoothX = 0;
    this.smoothY = 0;

    // How far the sampling window may slide, in *source-frame
    // fractions*. Set by the renderer, which is the only thing that
    // knows how much overscan the crop actually left us.
    this.limitU = 0;
    this.limitV = 0;

    /** Last correction, as a source-UV offset of the sampling window. */
    this.offset = { u: 0, v: 0 };
  }

  /**
   * @param {number} maxU  half-width of the slide budget, as a fraction
   *                       of the *source* frame width (not the gate).
   * @param {number} maxV  the same, vertically.
   */
  setLimits(maxU, maxV) {
    this.limitU = Math.max(0, maxU);
    this.limitV = Math.max(0, maxV);
  }

  /** Re-centre. Called when a new take starts, or the source changes. */
  reset() {
    this.pathX = this.pathY = 0;
    this.smoothX = this.smoothY = 0;
    this._havePrev = false;
    this.offset.u = 0;
    this.offset.v = 0;
  }

  /**
   * Measure this frame and return where the sampling window should
   * sit for it.
   *
   * @param {HTMLVideoElement} video
   * @param {number} dt  seconds since the previous tracked frame
   * @returns {{u: number, v: number}} sampling-window offset in source UV
   */
  track(video, dt) {
    if (!this._grab(video)) return this.offset;

    if (this._havePrev) {
      const { dx, dy } = this._estimate();
      this.pathX += dx;
      this.pathY += dy;
    }

    // Swap both levels, so this frame becomes the reference for the
    // next one.
    let t = this.prev; this.prev = this.cur; this.cur = t;
    t = this.prevL1; this.prevL1 = this.curL1; this.curL1 = t;
    this._havePrev = true;

    // One-pole low pass, framed as a time constant rather than a
    // per-frame coefficient so the result does not change if the
    // develop pass hands us frames at a different rate.
    const a = 1 - Math.exp(-clamp(dt, 1 / 240, 0.25) / Math.max(this.tau, 1e-3));
    this.smoothX += (this.pathX - this.smoothX) * a;
    this.smoothY += (this.pathY - this.smoothY) * a;

    // The slide: how far the real path has strayed from the smooth one.
    let wx = this.pathX - this.smoothX;
    let wy = this.pathY - this.smoothY;

    // Clamp to the overscan budget, then push the clamp *back* into
    // the smoothed path. Without that feedback the filter keeps
    // integrating against a wall it cannot move past, and when the
    // shot finally settles the frame drifts slowly back from the
    // corner it was pinned in — the classic wind-up artefact.
    const maxX = this.limitU * this.aw;
    const maxY = this.limitV * this.ah;
    wx = clamp(wx, -maxX, maxX);
    wy = clamp(wy, -maxY, maxY);

    // Give way near the end of the travel.
    //
    // A one-pole filter holds a lag proportional to how fast the
    // camera is moving, so any sustained move — a pan, a walk down a
    // corridor — eventually asks for more slide than the overscan
    // has. Left alone the correction simply pins against the limit
    // and stays there for the rest of the move, which looks fine but
    // means there is no budget left for the shake riding on top of
    // it, exactly when it is needed.
    //
    // So the last stretch of travel is made progressively soft: the
    // smoothed path is pulled toward the real one in proportion to
    // how much of the budget is already spent. Deliberate moves get
    // followed instead of resisted, and the budget comes back. It is
    // what a fluid head does when you push it past its range.
    wx *= 1 - this._release(wx, maxX);
    wy *= 1 - this._release(wy, maxY);

    this.smoothX = this.pathX - wx;
    this.smoothY = this.pathY - wy;

    // Analysis pixels → source UV. The vertical sign flips because
    // the analysis canvas counts rows downward while the video
    // texture is uploaded flipped, so its v axis runs upward.
    this.offset.u = wx / this.aw;
    this.offset.v = -wy / this.ah;
    return this.offset;
  }

  /**
   * How much of the correction to hand back this frame, 0…1, given
   * how far into the travel it already is. Nothing at all below
   * STEADY.softLimit — ordinary shake never notices this exists —
   * ramping to STEADY.release at the very end of the budget.
   */
  _release(w, max) {
    if (!(max > 0)) return 1;
    const used = Math.abs(w) / max;
    if (used <= STEADY.softLimit) return 0;
    return ((used - STEADY.softLimit) / (1 - STEADY.softLimit)) * STEADY.release;
  }

  /* =============================================================
     MEASUREMENT
     ============================================================= */

  /** Scale the frame down, reduce it to luma, and halve it again. */
  _grab(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;

    if (!this.aw || vw !== this._srcW || vh !== this._srcH) {
      this._srcW = vw;
      this._srcH = vh;
      const scale = this.longEdge / Math.max(vw, vh);
      // Even dimensions, so the half-resolution level is exact.
      this.aw = Math.max(16, Math.round(vw * scale) & ~1);
      this.ah = Math.max(16, Math.round(vh * scale) & ~1);
      this.hw = this.aw >> 1;
      this.hh = this.ah >> 1;
      this.canvas.width = this.aw;
      this.canvas.height = this.ah;
      this.cur = new Uint8Array(this.aw * this.ah);
      this.prev = new Uint8Array(this.aw * this.ah);
      this.curL1 = new Uint8Array(this.hw * this.hh);
      this.prevL1 = new Uint8Array(this.hw * this.hh);
      this.reset();
    }

    try {
      this.ctx.drawImage(video, 0, 0, this.aw, this.ah);
      const px = this.ctx.getImageData(0, 0, this.aw, this.ah).data;
      const out = this.cur;
      for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        // Integer luma: (77R + 150G + 29B) >> 8. Rec.601 weights are
        // fine here — this is a matching signal, not a picture.
        out[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
      }
    } catch {
      // Drivers occasionally refuse drawImage mid-decoder-reconfigure.
      return false;
    }

    // 2×2 box down to L1. The averaging is the point: it is the
    // low-pass that makes the coarse search's error surface smooth
    // enough to have a single obvious minimum.
    const { aw, hw, hh, cur, curL1 } = this;
    for (let y = 0; y < hh; y++) {
      const r0 = (y * 2) * aw, r1 = r0 + aw, o = y * hw;
      for (let x = 0; x < hw; x++) {
        const i = x * 2;
        curL1[o + x] = (cur[r0 + i] + cur[r0 + i + 1] + cur[r1 + i] + cur[r1 + i + 1]) >> 2;
      }
    }
    return true;
  }

  /**
   * Global translation between prev and cur, in analysis pixels.
   *
   * Returns the shift such that content sitting at p in the previous
   * frame now sits at p + (dx, dy) — i.e. how far the picture moved,
   * in screen coordinates, x right and y down.
   */
  _estimate() {
    const R = this.searchPx;
    const { prev, cur, aw, ah } = this;
    const stride = this.stride;

    // Coarse: every offset on the half-resolution level.
    const half = Math.max(1, R >> 1);
    const c = this._search(this.prevL1, this.curL1, this.hw, this.hh, half, 0, 0, half, 1);

    // Fine: ±2 around the coarse answer, on the full analysis level.
    const f = this._search(prev, cur, aw, ah, R, c.dx * 2, c.dy * 2, 2, stride);

    // How well the frames match at all, per sampled pixel. A cut, or
    // a whip pan smeared past recognition, has no true answer, and
    // integrating whatever the search picked is what makes a naive
    // stabiliser wander off.
    const samples = this._sampleCount(aw, ah, R, stride);
    if (f.best / samples > STEADY.maxResidual) return { dx: 0, dy: 0 };

    // A *large* claimed shift that barely beats "nothing moved" is
    // not believable either. Small ones are exempt: at these
    // resolutions genuine handheld tremor is often worth less than a
    // whole pixel, and its honest score is barely under the score
    // for standing still — which is exactly what this test would
    // throw away.
    if (Math.abs(f.dx) >= 2 || Math.abs(f.dy) >= 2) {
      const still = this._sad(prev, cur, aw, ah, R, 0, 0, stride, Infinity);
      if (!(still > 0) || f.best > still * STEADY.confidence) return { dx: 0, dy: 0 };
    }

    // Sub-pixel refinement, and this is not a nicety. One analysis
    // pixel is ~15 source pixels at these sizes, so an integer-only
    // correction both misses tremor smaller than that and moves the
    // frame in visible 15-pixel jumps when it does fire — trading
    // shake for a coarser shake. Fitting a parabola through the
    // scores either side of the minimum recovers roughly a tenth of
    // a pixel from three numbers we have already paid for.
    return {
      dx: f.dx + this._subPixel(prev, cur, aw, ah, R, f, stride, 1, 0),
      dy: f.dy + this._subPixel(prev, cur, aw, ah, R, f, stride, 0, 1),
    };
  }

  /**
   * Vertex of the parabola through the scores at the minimum and its
   * two neighbours along one axis, as an offset in [-0.5, 0.5].
   * Returns 0 where the neighbours fall outside the search range or
   * the three points do not form a minimum (a flat or concave run
   * means there is nothing to interpolate).
   */
  _subPixel(prev, cur, w, h, margin, f, stride, ax, ay) {
    // A residual of exactly zero means the frames matched perfectly
    // at a whole-pixel offset: the answer is already exact and there
    // is no fraction to recover. Interpolating anyway reads the
    // asymmetry of the surrounding scores as motion, and a locked-off
    // shot slowly creeps — the interpolation has to be *told* when
    // it has nothing to do.
    if (!(f.best > 0)) return 0;

    const lo = { x: f.dx - ax, y: f.dy - ay };
    const hi = { x: f.dx + ax, y: f.dy + ay };
    if (Math.abs(lo.x) > margin || Math.abs(lo.y) > margin ||
        Math.abs(hi.x) > margin || Math.abs(hi.y) > margin) return 0;

    const a = this._sad(prev, cur, w, h, margin, lo.x, lo.y, stride, Infinity);
    const b = this._sad(prev, cur, w, h, margin, hi.x, hi.y, stride, Infinity);
    const denom = a - 2 * f.best + b;
    if (denom <= 0) return 0;
    return Math.max(-0.5, Math.min(0.5, (a - b) / (2 * denom)));
  }

  /**
   * Score every offset within `radius` of (cx, cy) and return the
   * best. `margin` is how much border the caller has to leave
   * unsearched, and is always the *largest* offset that level will
   * ever be asked about — not this call's radius — so the compared
   * region stays identical between the coarse and fine passes and
   * their scores remain comparable.
   *
   * The centre is seeded as the incumbent rather than starting from
   * Infinity, so that a tie leaves the answer where the caller's
   * prior already put it. On a featureless frame every offset scores
   * identically, and a search that lets the first candidate win
   * returns the corner of its own search range with total confidence.
   */
  _search(prev, cur, w, h, margin, cx, cy, radius, stride) {
    let bx = cx, by = cy;
    let best = this._sad(prev, cur, w, h, margin, cx, cy, stride, Infinity);

    for (let dy = cy - radius; dy <= cy + radius; dy++) {
      if (dy < -margin || dy > margin) continue;
      for (let dx = cx - radius; dx <= cx + radius; dx++) {
        if (dx < -margin || dx > margin) continue;
        if (dx === cx && dy === cy) continue;
        const s = this._sad(prev, cur, w, h, margin, dx, dy, stride, best);
        if (s < best) { best = s; bx = dx; by = dy; }
      }
    }
    return { dx: bx, dy: by, best };
  }

  /** How many pixels a _sad() over these bounds actually compares. */
  _sampleCount(w, h, margin, stride) {
    const nx = Math.ceil(Math.max(0, w - 2 * margin) / stride);
    const ny = Math.ceil(Math.max(0, h - 2 * margin) / stride);
    return Math.max(1, nx * ny);
  }

  /**
   * Sum of absolute differences at one candidate offset, over the
   * interior of the frame only — the border is where content shifts
   * in from outside and would be compared against nothing. Bails the
   * moment it passes the incumbent score.
   */
  _sad(prev, cur, w, h, margin, dx, dy, stride, ceiling) {
    const x0 = margin, x1 = w - margin;
    const y0 = margin, y1 = h - margin;
    if (x1 <= x0 || y1 <= y0) return Infinity;

    let sum = 0;
    for (let y = y0; y < y1; y += stride) {
      const a = y * w;
      const b = (y + dy) * w + dx;
      for (let x = x0; x < x1; x += stride) {
        const d = prev[a + x] - cur[b + x];
        sum += d < 0 ? -d : d;
      }
      if (sum >= ceiling) return sum;   // early out, row granularity
    }
    return sum;
  }
}
