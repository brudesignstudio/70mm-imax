/**
 * Histogram.js
 * ---------------------------------------------------------------
 * A live luminance + RGB histogram of whatever is on screen — the
 * raw camera feed while framing, since there is no live grade to
 * read any more (see FilmRenderer.js).
 *
 * Reading pixels back every frame at full resolution would stall
 * the pipeline. Instead the source is drawn into a 64×45 2-D canvas
 * a few times a second and sampled from there: ~2,900 pixels is
 * more than enough for a 64-bucket histogram, and the cost is
 * invisible. drawImage() accepts a <canvas> or a <video> alike, so
 * the source can be either.
 */

const SAMPLE_W = 64;
const SAMPLE_H = 45;
const BUCKETS = 64;

export class Histogram {
  /**
   * @param {HTMLCanvasElement} canvas  the small display canvas
   * @param {HTMLCanvasElement} source  the graded output canvas
   */
  constructor(canvas, source) {
    this.canvas = canvas;
    this.source = source;
    this.ctx = canvas.getContext('2d');

    this.sampler = document.createElement('canvas');
    this.sampler.width = SAMPLE_W;
    this.sampler.height = SAMPLE_H;
    this.sctx = this.sampler.getContext('2d', { willReadFrequently: true });

    this.lum = new Float32Array(BUCKETS);
    this.r = new Float32Array(BUCKETS);
    this.g = new Float32Array(BUCKETS);
    this.b = new Float32Array(BUCKETS);

    this.enabled = true;
    this.intervalMs = 160;   // ~6Hz: readable, cheap
    this._lastAt = 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.canvas.hidden = !on;
    if (!on) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Call once per rendered frame; internally rate-limited. */
  update(now = performance.now()) {
    if (!this.enabled) return;
    if (now - this._lastAt < this.intervalMs) return;
    this._lastAt = now;
    // A <video> reports its pixel size on videoWidth/videoHeight,
    // not width/height (those only reflect HTML attributes); a
    // <canvas> is the reverse. Read whichever is real.
    const w = this.source.videoWidth || this.source.width;
    const h = this.source.videoHeight || this.source.height;
    if (!w || !h) return;

    try {
      this.sctx.drawImage(this.source, 0, 0, SAMPLE_W, SAMPLE_H);
    } catch { return; }

    let data;
    try { data = this.sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data; }
    catch { return; }

    this.lum.fill(0); this.r.fill(0); this.g.fill(0); this.b.fill(0);
    const scale = (BUCKETS - 1) / 255;

    for (let i = 0; i < data.length; i += 4) {
      const R = data[i], G = data[i + 1], B = data[i + 2];
      this.r[(R * scale) | 0]++;
      this.g[(G * scale) | 0]++;
      this.b[(B * scale) | 0]++;
      this.lum[((0.2126 * R + 0.7152 * G + 0.0722 * B) * scale) | 0]++;
    }

    this._draw();
  }

  _draw() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Normalise against the luminance peak so the channels stay
    // comparable to each other rather than each self-scaling.
    let peak = 1;
    for (let i = 0; i < BUCKETS; i++) if (this.lum[i] > peak) peak = this.lum[i];

    const bw = w / BUCKETS;

    // Channels, additively blended: the classic RGB parade look.
    ctx.globalCompositeOperation = 'lighter';
    const channels = [
      [this.r, 'rgba(255, 74, 60, .55)'],
      [this.g, 'rgba(96, 224, 120, .5)'],
      [this.b, 'rgba(90, 150, 255, .5)'],
    ];
    for (const [buf, color] of channels) {
      ctx.fillStyle = color;
      for (let i = 0; i < BUCKETS; i++) {
        const v = Math.min(1, buf[i] / peak);
        const bh = v * h;
        if (bh > 0.4) ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.4), bh);
      }
    }

    // Luminance outline on top.
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(244, 236, 224, .8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < BUCKETS; i++) {
      const v = Math.min(1, this.lum[i] / peak);
      const x = i * bw + bw / 2;
      const y = h - v * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Clipping markers: a tick when either end is pinned. On a
    // large-format negative you have latitude, but not infinite
    // latitude.
    const total = SAMPLE_W * SAMPLE_H;
    if (this.lum[0] / total > 0.06) {
      ctx.fillStyle = 'rgba(90, 150, 255, .9)';
      ctx.fillRect(0, 0, 2, h);
    }
    if (this.lum[BUCKETS - 1] / total > 0.03) {
      ctx.fillStyle = 'rgba(255, 74, 60, .9)';
      ctx.fillRect(w - 2, 0, 2, h);
    }
  }
}
