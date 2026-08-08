/**
 * FilmRenderer.js
 * ---------------------------------------------------------------
 * The optical bench. Takes a <video> element and renders a graded
 * frame, cropped to FORMAT.ASPECT, into a WebGL canvas.
 *
 * This never runs live: shooting records the raw camera stream
 * untouched (see Recorder + main.js) so the viewfinder stays as
 * close to a stock camera app as a web page gets — no shader, no
 * heat, no lag. The grade happens exactly once, during developing,
 * fed by an offscreen <video> replaying the raw take (Developer.js
 * drives it frame-by-frame). What comes out of this bench is what
 * gets re-encoded, so there is still no drift between what the
 * operator reviews and what gets saved — it is just produced once,
 * after the fact, instead of live.
 *
 * Everything constant across a frame is computed here on the CPU
 * and handed to the GPU as a uniform; the shaders do no per-pixel
 * work that could have been hoisted.
 */

import { FORMAT, QUALITY, STEADY } from '../config.js';
import {
  getContext, createProgram, createFullscreenTriangle,
  createRenderTarget, resizeRenderTarget, destroyRenderTarget,
  createVideoTexture, createGrainTexture, bindTexture,
} from '../utils/webgl.js';
import { VERT, FRAG_BRIGHT, FRAG_BLUR, FRAG_DOWN, FRAG_COMPOSITE } from '../shaders/shaders.js';
import { Stabilizer } from './Stabilizer.js';

/* --- CPU-side value noise for gate weave ----------------------
   Mechanical wander is low-frequency and smooth; white noise would
   read as digital shake. */
function hash1(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453123;
  return s - Math.floor(s);
}
function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

/** Frozen head — what the gate sees with the steadicam switched off. */
const ZERO_STEADY = Object.freeze({ u: 0, v: 0 });

/**
 * The centre-crop that fits a `target`-aspect gate inside a
 * `vw`×`vh` source, as [scaleX, scaleY, offsetX, offsetY] in UV.
 * Exported because the live viewfinder crops to the same aspect
 * with plain CSS object-fit — this is what makes a tap-to-focus
 * point on that raw video map back to the same sensor coordinates
 * this renderer would have used, without a live shader to ask.
 */
export function coverCrop(vw, vh, target) {
  const srcAspect = vw / vh;
  let cropW, cropH;
  if (srcAspect > target) {        // source wider than the target
    cropH = vh;
    cropW = vh * target;
  } else {                         // source taller than the target
    cropW = vw;
    cropH = vw / target;
  }
  const sx = cropW / vw;
  const sy = cropH / vh;
  return [sx, sy, (1 - sx) / 2, (1 - sy) / 2];
}

export class FilmRenderer {
  /**
   * @param {HTMLCanvasElement} canvas  output canvas (also the record source)
   * @param {object} look               a LOOK-shaped object (live-tunable)
   */
  constructor(canvas, look) {
    this.canvas = canvas;
    this.look = look;
    this.quality = QUALITY.high;

    this.gl = getContext(canvas);
    if (!this.gl) throw new Error('WebGL is not available on this browser.');

    this.source = null;          // HTMLVideoElement
    this.sourceW = 0;
    this.sourceH = 0;
    this.width = 0;
    this.height = 0;
    this.crop = [1, 1, 0, 0];    // scaleX, scaleY, offsetX, offsetY
    this.digitalZoom = 1;        // baked-in crop zoom, for lenses/UAs with no hardware zoom
    this._zoomDirty = false;
    this.startedAt = performance.now();
    this.frames = 0;
    this.lastFpsAt = this.startedAt;
    this.fps = 0;

    // The steadicam. Off until asked for, because switching it on
    // costs overscan (a tighter frame) as well as time — see
    // setSteady() and Stabilizer.js.
    this.stabilizer = null;
    this._lastTrackAt = null;

    // Last frame's gate vector, so the shutter blend can sample the
    // previous frame through the transform it was actually rendered
    // with rather than through this frame's.
    this._gate = [1, 0, 0];
    this._gatePrev = [1, 0, 0];

    // Two video textures, alternating: one holds this frame, the
    // other still holds the last one. Cheaper than copying a frame
    // aside every tick, and the only reason a shutter blend is
    // affordable at all.
    this._texIndex = 0;
    this._textureSized = [false, false];
    this._havePrevFrame = false;

    this._initGL();
  }

  /* =============================================================
     SET-UP
     ============================================================= */
  _initGL() {
    const gl = this.gl;

    this.programs = {
      bright:    createProgram(gl, VERT, FRAG_BRIGHT),
      blur:      createProgram(gl, VERT, FRAG_BLUR),
      down:      createProgram(gl, VERT, FRAG_DOWN),
      composite: createProgram(gl, VERT, FRAG_COMPOSITE),
    };

    this.quad = createFullscreenTriangle(gl);
    this.videoTextures = [createVideoTexture(gl), createVideoTexture(gl)];
    this.grainTexture = createGrainTexture(gl);

    // A 1×1 black texture stands in for bloom/halation when a
    // quality tier disables them — cheaper than branching in the
    // composite shader and keeps sampler slots bound.
    this.blackTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blackTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Offscreen chain, allocated lazily in _resize().
    this.rt = { bloomA: null, bloomB: null, haloA: null, haloB: null };

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.clearColor(0, 0, 0, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  /** The current frame's texture, and the one before it. */
  get videoTexture() { return this.videoTextures[this._texIndex]; }
  get prevTexture() { return this.videoTextures[this._texIndex ^ 1]; }

  /** Swap in a new camera stream. */
  setSource(video) {
    this.source = video;
    this.sourceW = 0;           // force a resize on the next frame
    this._textureSized = [false, false];
    this._havePrevFrame = false;
    this._lastTrackAt = null;
    this.stabilizer?.reset();
  }

  setQuality(tier) {
    this.quality = QUALITY[tier] || QUALITY.high;
    this.sourceW = 0;           // re-derive render-target sizes
  }

  setLook(look) { this.look = look; }

  /**
   * Turn the steadicam on or off.
   *
   * Switching it on changes the crop — the correction has to slide
   * the frame into margin that was deliberately cropped away — so
   * this re-derives the geometry rather than only setting a flag.
   */
  setSteady(on) {
    const want = !!on;
    if (want === !!this.stabilizer) return;
    this.stabilizer = want ? new Stabilizer() : null;
    this._lastTrackAt = null;
    this._zoomDirty = true;
  }

  /** Re-centre the head — called when a real take is about to start,
   *  so priming frames do not leave the path already displaced. */
  resetSteady() {
    this.stabilizer?.reset();
    this._lastTrackAt = null;
  }

  /** Total crop factor: format zoom × steadicam overscan. */
  get _cropZoom() {
    return Math.max(1, this.digitalZoom) * (this.stabilizer ? STEADY.crop : 1);
  }

  /**
   * A baked-in crop zoom for lenses/browsers with no hardware zoom
   * constraint. 1 = no zoom. Applied on top of the format crop, so
   * a 2× digital zoom just means "crop half as much frame, into the
   * same output size" — no separate code path.
   */
  setDigitalZoom(z) {
    z = Math.max(1, z || 1);
    if (z === this.digitalZoom) return;
    this.digitalZoom = z;
    this._zoomDirty = true;
  }

  /* =============================================================
     SIZING — output is always exactly FORMAT.ASPECT
     ============================================================= */
  _resize() {
    const gl = this.gl;
    const vw = this.source.videoWidth;
    const vh = this.source.videoHeight;
    if (!vw || !vh) return false;
    if (vw === this.sourceW && vh === this.sourceH && !this._zoomDirty) return true;

    this.sourceW = vw;
    this.sourceH = vh;
    this._textureSized = [false, false];
    this._havePrevFrame = false;
    this._zoomDirty = false;

    // --- Centre-crop the sensor image to the IMAX gate ---------
    const target = FORMAT.ASPECT;
    const [baseSx, baseSy] = coverCrop(vw, vh, target);
    // Output resolution is sized off the *unzoomed* crop — zoom
    // changes which part of the sensor is sampled, not how many
    // pixels come out the other end. Cap the long edge rather than
    // the width, so a portrait gate does not scale up to a frame no
    // mobile encoder will take. Even dimensions throughout: hardware
    // H.264 encoders require macroblock alignment and silently
    // letterbox or fail on odd sizes.
    const longEdge = Math.min(
      FORMAT.MAX_LONG_EDGE,
      Math.round(Math.max(baseSx * vw, baseSy * vh) * FORMAT.PREVIEW_SCALE)
    );

    // Digital zoom and the steadicam's overscan then shrink the
    // *sampled* crop box around its own centre — cheaper than
    // reflowing the aspect-fit math, and exactly equivalent to it.
    // They multiply because they are the same operation: sample less
    // of the sensor into the same number of output pixels. Zoom does
    // it to reach; the steadicam does it to leave margin to slide
    // into.
    const zoom = this._cropZoom;
    const sx = zoom > 1 ? baseSx / zoom : baseSx;
    const sy = zoom > 1 ? baseSy / zoom : baseSy;
    this.crop = [sx, sy, (1 - sx) / 2, (1 - sy) / 2];

    // How far the sampling window may slide before it runs off the
    // edge of what was captured, as a fraction of the source frame:
    // half the difference between the crop we would have taken and
    // the (tighter) one we actually took. Gate weave and breathing
    // are held back out of that budget, since they ride on the same
    // offset and would otherwise be the thing that clips.
    if (this.stabilizer) {
      const g = this.look.gate;
      const reserve = (g.weave + g.breathing * 0.5);
      this.stabilizer.setLimits(
        Math.max(0, (baseSx - sx) / 2 - reserve * sx),
        Math.max(0, (baseSy - sy) / 2 - reserve * sy),
      );
    }

    let w = target >= 1 ? longEdge : Math.round(longEdge * target);
    let h = target >= 1 ? Math.round(longEdge / target) : longEdge;
    w = Math.max(2, w - (w % 2));
    h = Math.max(2, h - (h % 2));

    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    // --- Offscreen chain ---------------------------------------
    const q = this.quality;
    const bw = Math.max(1, Math.floor(w / q.bloomDiv));
    const bh = Math.max(1, Math.floor(h / q.bloomDiv));
    const hw = Math.max(1, Math.floor(w / q.haloDiv));
    const hh = Math.max(1, Math.floor(h / q.haloDiv));

    this.rt.bloomA = this.rt.bloomA ? resizeRenderTarget(gl, this.rt.bloomA, bw, bh) : createRenderTarget(gl, bw, bh);
    this.rt.bloomB = this.rt.bloomB ? resizeRenderTarget(gl, this.rt.bloomB, bw, bh) : createRenderTarget(gl, bw, bh);
    this.rt.haloA  = this.rt.haloA  ? resizeRenderTarget(gl, this.rt.haloA,  hw, hh) : createRenderTarget(gl, hw, hh);
    this.rt.haloB  = this.rt.haloB  ? resizeRenderTarget(gl, this.rt.haloB,  hw, hh) : createRenderTarget(gl, hw, hh);

    return true;
  }

  /* =============================================================
     PASS PLUMBING
     ============================================================= */
  _bindTarget(rt) {
    const gl = this.gl;
    if (rt) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
      gl.viewport(0, 0, rt.width, rt.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
    }
  }

  _draw() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); }

  /**
   * Upload the current video frame into whichever of the two video
   * textures is not currently holding the previous frame, then make
   * it the current one. texSubImage2D after the first allocation
   * avoids a full reallocation every frame.
   */
  _uploadFrame() {
    const gl = this.gl;
    const next = this._texIndex ^ 1;
    // Unit 0 explicitly: the composite pass leaves a different unit
    // active, and with two video textures alternating, uploading onto
    // whichever unit happened to be current is a trap.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTextures[next]);
    try {
      if (this._textureSized[next]) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
        this._textureSized[next] = true;
      }
    } catch {
      // Some drivers throw while the decoder is mid-reconfigure;
      // skipping the upload (and the swap) just repeats the frame
      // that is already current.
      return false;
    }
    // Whatever was current is now the previous frame — but only call
    // it usable once a real frame has actually landed in it.
    this._havePrevFrame = this._textureSized[this._texIndex];
    this._texIndex = next;
    return true;
  }

  /**
   * Mix weight toward the previous frame for a given shutter angle.
   *
   * A shutter open for a fraction e of the frame interval integrates
   * light over a window ending at this frame, so the centre of that
   * window sits e/2 of the way back toward the previous one. With
   * two samples to work with, that fraction *is* the mix — 180°
   * gives 0.25 — which is why the term tops out at 0.5 rather than
   * at 1: a fully open shutter is an equal blend of two frames, not
   * a dissolve to the older one.
   */
  _shutterWeight() {
    const angle = this.look.shutter?.angle;
    if (!angle || angle <= 0) return 0;
    return Math.min(0.5, angle / 720);
  }

  /**
   * Gate mechanics, evaluated once per frame on the CPU. This
   * renderer only ever runs during developing, never as a live
   * preview, so weave and breathing are simply always on — there is
   * no "distracting while framing" case to switch off any more.
   */
  _gateUniform(t, steady) {
    const g = this.look.gate;
    const breath = (g.breathing)
      ? 1 + g.breathing * Math.sin(t * g.breathingSpeed * Math.PI * 2)
      : 1;
    const wx = g.weave ? (vnoise(t * g.weaveSpeed) * 2 - 1) * g.weave : 0;
    const wy = g.weave ? (vnoise(t * g.weaveSpeed * 0.73 + 17) * 2 - 1) * g.weave * 0.55 : 0;
    // The steadicam's correction arrives as a source-UV offset; the
    // gate offset is applied *before* the crop scale, so it divides
    // back out. Without that, a correction would be worth more
    // horizontally than vertically on a gate that crops one axis
    // harder than the other.
    return [
      1 / breath,
      wx + steady.u / this.crop[0],
      wy + steady.v / this.crop[1],
    ];
  }

  /** Same low-frequency noise as the gate, offset in noise-space so
   *  the grain tile's sample position wanders independently. */
  _grainOffsetUniform(t, cadence) {
    const step = Math.floor(t * cadence);
    return [
      vnoise(step * 0.31 + 4.1) * 128,
      vnoise(step * 0.31 + 91.7) * 128,
    ];
  }

  /* =============================================================
     RENDER — one frame
     ============================================================= */
  render(nowMs = performance.now()) {
    const gl = this.gl;
    const video = this.source;
    if (!video || video.readyState < 2) return false;
    if (!this._resize()) return false;

    // The steadicam measures the frame *before* it is uploaded, so
    // the correction it returns lands on the same frame it was
    // measured from. dt comes from the caller's clock (the footage's
    // own media time during developing), not wall time, so the
    // smoothing behaves the same whether the develop pass is keeping
    // up or falling behind.
    let steady = ZERO_STEADY;
    if (this.stabilizer) {
      const dt = this._lastTrackAt === null ? 1 / FORMAT.FPS : (nowMs - this._lastTrackAt) / 1000;
      this._lastTrackAt = nowMs;
      steady = this.stabilizer.track(video, dt);
    }

    if (!this._uploadFrame()) return false;

    const L = this.look;
    const q = this.quality;
    const t = (nowMs - this.startedAt) / 1000;

    // This frame's gate becomes the reference the *next* frame's
    // shutter blend samples the previous picture through.
    this._gatePrev = this._havePrevFrame ? this._gate : null;
    const gate = this._gate = this._gateUniform(t, steady);
    const crop = this.crop;

    /* ---- 1. bright pass ------------------------------------- */
    let bloomTex = this.blackTexture;
    let haloTex  = this.blackTexture;

    if (q.bloom && (L.bloom.strength > 0 || (q.halation && L.halation.strength > 0))) {
      const p = this.programs.bright;
      gl.useProgram(p.program);
      bindTexture(gl, this.videoTexture, 0, p.uniforms.uSrc);
      gl.uniform4fv(p.uniforms.uCrop, crop);
      gl.uniform3fv(p.uniforms.uGate, gate);
      gl.uniform1f(p.uniforms.uThreshold, L.bloom.threshold);
      gl.uniform1f(p.uniforms.uKnee, L.bloom.knee);
      this._bindTarget(this.rt.bloomA);
      this._draw();

      /* ---- 2. blur the bloom chain -------------------------- */
      this._blur(this.rt.bloomA, this.rt.bloomB, L.bloom.radius);
      bloomTex = this.rt.bloomA.texture;

      /* ---- 3. halation: downsample further, blur wider ------ */
      if (q.halation && L.halation.strength > 0) {
        const d = this.programs.down;
        gl.useProgram(d.program);
        bindTexture(gl, this.rt.bloomA.texture, 0, d.uniforms.uSrc);
        gl.uniform2f(d.uniforms.uTexel, 1 / this.rt.bloomA.width, 1 / this.rt.bloomA.height);
        this._bindTarget(this.rt.haloA);
        this._draw();

        this._blur(this.rt.haloA, this.rt.haloB, L.halation.radius);
        haloTex = this.rt.haloA.texture;
      }
    }

    /* ---- 4. composite to the canvas ------------------------- */
    const p = this.programs.composite;
    const u = p.uniforms;
    gl.useProgram(p.program);

    // The shutter can only be honoured once there is a real previous
    // frame to integrate against; on the first frame of a take it is
    // simply off, and the sampler is pointed at the black stand-in
    // rather than at a texture nothing has been uploaded to yet.
    const shutter = this._gatePrev ? this._shutterWeight() : 0;

    bindTexture(gl, this.videoTexture, 0, u.uSrc);
    bindTexture(gl, bloomTex, 1, u.uBloom);
    bindTexture(gl, haloTex, 2, u.uHalo);
    bindTexture(gl, this.grainTexture, 3, u.uGrainTex);
    bindTexture(gl, shutter > 0 ? this.prevTexture : this.blackTexture, 4, u.uPrev);

    gl.uniform4fv(u.uCrop, crop);
    gl.uniform3fv(u.uGate, gate);
    gl.uniform1f(u.uShutter, shutter);
    gl.uniform3fv(u.uGatePrev, this._gatePrev || gate);
    // One source texel expressed in *output* UV, so the unsharp
    // radius is a true pixel regardless of crop.
    gl.uniform2f(u.uSrcTexel, 1 / (this.sourceW * crop[0]), 1 / (this.sourceH * crop[1]));
    gl.uniform2f(u.uRes, this.width, this.height);
    gl.uniform1f(u.uAspect, FORMAT.ASPECT);

    gl.uniform1f(u.uEV, L.exposure.ev);
    gl.uniform1f(u.uAberration, L.lens.aberration);
    gl.uniform1f(u.uVignette, L.lens.vignette);
    gl.uniform1f(u.uVigFalloff, L.lens.vignetteFalloff);
    gl.uniform1f(u.uSharpen, L.print.sharpen);

    gl.uniform1f(u.uBloomStrength, q.bloom ? L.bloom.strength : 0);
    gl.uniform1f(u.uHaloStrength, q.halation ? L.halation.strength : 0);
    gl.uniform3fv(u.uHaloTint, L.halation.tint);

    const T = L.tone;
    gl.uniform4f(u.uToneA, T.shoulder, T.linearStrength, T.linearAngle, T.toe);
    gl.uniform3f(u.uToneB, T.toeNumerator, T.toeDenominator, T.whitePoint);
    gl.uniform1f(u.uContrast, T.contrast);
    gl.uniform1f(u.uBlack, T.blackPoint);
    gl.uniform1f(u.uShadowDensity, T.shadowDensity);

    const C = L.color;
    gl.uniform1f(u.uSat, C.saturation);
    gl.uniform1f(u.uHiDesat, C.highlightDesat);
    gl.uniform3fv(u.uShadowTint, C.shadowTint);
    gl.uniform3fv(u.uHighTint, C.highlightTint);

    const G = L.grain;
    gl.uniform1f(u.uGrainStrength, G.strength);
    gl.uniform1f(u.uGrainSize, G.size);
    gl.uniform1f(u.uGrainChroma, G.chroma);
    gl.uniform1f(u.uGrainShadow, G.shadowBias);
    // Quantising to 24fps is what separates film grain from video
    // noise: it must hold for the whole frame. uGrainSeed still
    // drives the dither hash below; uGrainOffset is the same
    // quantised tick applied to the pre-baked grain texture instead.
    const cadence = G.cadence || FORMAT.CADENCE;
    gl.uniform1f(u.uGrainSeed, Math.floor(t * cadence) % 4096);
    gl.uniform2fv(u.uGrainOffset, this._grainOffsetUniform(t, cadence));

    gl.uniform1f(u.uDither, L.print.dither);

    this._bindTarget(null);
    this._draw();

    /* ---- 5. rolling fps, for the settings readout ----------- */
    this.frames++;
    if (nowMs - this.lastFpsAt >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (nowMs - this.lastFpsAt));
      this.frames = 0;
      this.lastFpsAt = nowMs;
    }
    return true;
  }

  /** Horizontal then vertical pass, ping-ponging a→b→a. */
  _blur(a, b, radius) {
    const gl = this.gl;
    const p = this.programs.blur;
    gl.useProgram(p.program);
    gl.uniform1f(p.uniforms.uRadius, radius);
    gl.uniform2f(p.uniforms.uTexel, 1 / a.width, 1 / a.height);

    bindTexture(gl, a.texture, 0, p.uniforms.uSrc);
    gl.uniform2f(p.uniforms.uDir, 1, 0);
    this._bindTarget(b);
    this._draw();

    bindTexture(gl, b.texture, 0, p.uniforms.uSrc);
    gl.uniform2f(p.uniforms.uDir, 0, 1);
    this._bindTarget(a);
    this._draw();
  }

  /** Paint a single black frame — used when the camera stops. */
  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** True once the driver has taken the context away from us. */
  get isLost() { return this.gl.isContextLost(); }

  /**
   * Release GPU objects. Deliberately does *not* call
   * WEBGL_lose_context: a canvas only ever hands out one context,
   * so losing it would make the viewfinder unrecoverable for the
   * lifetime of the page — including on the context-restored path,
   * which is exactly when a rebuild is needed.
   */
  destroy() {
    const gl = this.gl;
    if (gl.isContextLost()) return;   // objects are already gone
    Object.values(this.rt).forEach((rt) => destroyRenderTarget(gl, rt));
    Object.values(this.programs).forEach(({ program }) => gl.deleteProgram(program));
    this.videoTextures.forEach((t) => gl.deleteTexture(t));
    gl.deleteTexture(this.blackTexture);
    gl.deleteTexture(this.grainTexture);
    gl.deleteBuffer(this.quad);
  }
}
