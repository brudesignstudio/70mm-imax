/**
 * Developer.js
 * ---------------------------------------------------------------
 * Turns a raw take into the finished one.
 *
 * Shooting records the raw camera stream untouched — no shader, no
 * heat, no lag; see Recorder + main.js. All of the actual film
 * pipeline runs here, once, after the shutter is released: the raw
 * recording is played back through FilmRenderer, which grades it and
 * draws the sprocket bars around it on one WebGL canvas, and that
 * canvas is what gets re-encoded through the same Recorder class
 * shooting uses.
 *
 * "One canvas" is load-bearing. This used to grade onto an offscreen
 * WebGL canvas and then copy the result into a second, 2D canvas
 * that carried the sprocket border — a whole extra full-frame copy
 * per frame, inside a budget that already has to fit a decode, a
 * grade and an encode into one frame interval. Miss that budget and
 * the captured stream starts repeating frames, which is exactly the
 * judder the develop pass exists to avoid.
 *
 * That means developing takes about as long as the take itself (a
 * 3-minute take takes roughly 3 minutes to develop) — the trade for
 * a viewfinder that never runs a shader. The "Developing" screen
 * exists either way; this is what it is actually doing now.
 */

import { FORMAT, RECORDING, EXPORT_FRAME } from '../config.js';
import { FilmRenderer } from './FilmRenderer.js';
import { Recorder } from './Recorder.js';

/** How often the "Developing… n%" readout is allowed to change. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * The film-strip border art is static and shared by every take, so
 * it is loaded once and cached rather than re-fetched per Developer
 * instance.
 */
let _filmStripImagePromise = null;
function loadFilmStripImage() {
  if (!_filmStripImagePromise) {
    _filmStripImagePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The film-strip artwork failed to load.'));
      img.src = EXPORT_FRAME.image;
    });
  }
  return _filmStripImagePromise;
}

export class Developer {
  /**
   * @param {object} opts { look, quality, digitalZoom, steady, onProgress }
   *   look        the live LOOK object from Settings (grade to apply)
   *   quality     QUALITY tier key
   *   digitalZoom baked-in crop zoom chosen before the take started,
   *               for lenses/browsers with no hardware zoom (1 = none)
   *   steady      run the steadicam over the take (PREFS.steady)
   *   onProgress  (fraction: number) => void, 0..1
   */
  constructor({ look, quality = 'high', digitalZoom = 1, steady = true, onProgress } = {}) {
    this.look = look;
    this.quality = quality;
    this.digitalZoom = digitalZoom;
    this.steady = steady;
    this.onProgress = onProgress;
    this._lastProgressAt = 0;

    // Replays the raw take. Kept out of the layout (off-screen, zero
    // size) rather than truly detached from the document: WebKit
    // throttles decode on a <video> that is never part of the render
    // tree at all, which was part of why audio silently dropped out
    // once developing started. Nothing here needs it to be *seen*.
    //
    // Silenced via volume, not the `muted` property: WebKit hands
    // back a dead-silent audio track from captureStream() on a
    // muted element, which was making every developed export come
    // out with no sound. `muted` starts true only because autoplay
    // policies key off it; _run() drops it back to false right
    // after play() succeeds, once volume 0 is already guaranteed to
    // keep it inaudible, so the audio captured downstream is real.
    this.sourceVideo = document.createElement('video');
    this.sourceVideo.muted = true;
    this.sourceVideo.volume = 0;
    this.sourceVideo.playsInline = true;
    this.sourceVideo.setAttribute('webkit-playsinline', '');
    this.sourceVideo.setAttribute('playsinline', '');
    this.sourceVideo.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(this.sourceVideo);

    // The Web Audio graph used to pull real audio out of sourceVideo
    // for the final recording — see _buildAudioTrack().
    this.audioCtx = null;

    // The one canvas: the grade and the sprocket border both land
    // here, and this is what MediaRecorder captures. It *is* meant
    // to be shown — the caller can mount it wherever the
    // "Developing" screen wants a live preview — but nothing here
    // requires it to be in the document.
    this.exportCanvas = document.createElement('canvas');
    this.renderer = null;

    /** The capture track, when this engine lets us clock it by hand
     *  — see _captureStream(). */
    this._captureTrack = null;

    this.recorder = new Recorder(
      { getStream: (fps) => this._captureStream(fps) },
      {
        onStop: (result) => this._onRecorderStop(result),
        onError: (err) => { this._cleanup(); this._rejectFinal?.(err); },
      }
    );

    this._driving = false;
    this._rvfcHandle = 0;
    this._durationMs = 1;
    this._gradedFrames = 0;
    this._gradingStartedAt = 0;

    // Rare on a mobile GPU under memory pressure, but developing can
    // run for minutes — long enough to actually hit it.
    this.exportCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._cleanup();
      this._rejectFinal?.(new Error('The graphics context was lost while developing.'));
    });
  }

  /**
   * @param {{ blob: Blob, durationMs: number }} rawTake
   * @returns {Promise<{ blob: Blob, mimeType: string, durationMs: number, width: number, height: number }>}
   */
  develop(rawTake) {
    this._durationMs = Math.max(1, rawTake.durationMs || 1);
    const rawURL = URL.createObjectURL(rawTake.blob);
    this._rawURL = rawURL;

    return new Promise((resolve, reject) => {
      this._resolveFinal = resolve;
      this._rejectFinal = reject;
      this._run(rawURL).catch((err) => { this._cleanup(); reject(err); });
    });
  }

  async _run(rawURL) {
    const v = this.sourceVideo;
    v.src = rawURL;

    const [, filmStripImg] = await Promise.all([
      new Promise((res, rej) => {
        const onMeta = () => { v.removeEventListener('error', onErr); res(); };
        const onErr = () => { v.removeEventListener('loadedmetadata', onMeta); rej(new Error('The raw take could not be decoded.')); };
        v.addEventListener('loadedmetadata', onMeta, { once: true });
        v.addEventListener('error', onErr, { once: true });
      }),
      loadFilmStripImage(),
    ]);
    this._filmStripImg = filmStripImg;
    await this._fixDuration(v);

    this.renderer = new FilmRenderer(this.exportCanvas, this.look);
    // Synced to the footage's own clock, not wall time, so gate
    // weave/breathing/grain phase are deterministic and unaffected
    // by any pause/resume while backgrounded.
    this.renderer.startedAt = 0;
    this.renderer.setQuality(this.quality);
    this.renderer.setFilmStrip(filmStripImg);
    this.renderer.setDigitalZoom(this.digitalZoom);
    this.renderer.setSteady(this.steady);
    this.renderer.setSource(v);

    await v.play();
    v.muted = false;  // volume is already 0; see the constructor's comment
    await this._prime();

    // Priming renders a frame or two before the take proper starts.
    // Those frames are real enough for the steadicam to have measured
    // motion from, so the head is re-centred here — otherwise the
    // first recorded frame can already be sitting off-centre.
    this.renderer.resetSteady();

    const audioTrack = await this._buildAudioTrack(v);

    await this.recorder.start({
      audioTrack,
      fps: FORMAT.FPS,
      videoBitsPerSecond: RECORDING.VIDEO_BPS,
      // Belt and braces, same reasoning as live recording: 'ended'
      // is the normal path, this is the guaranteed ceiling.
      maxMs: this._durationMs + 8000,
    });

    this._gradedFrames = 0;
    this._gradingStartedAt = performance.now();
    this._startPump();
    v.addEventListener('ended', () => this._finish(), { once: true });
  }

  /**
   * MediaRecorder output — a canvas.captureStream() source
   * especially, but not only that — can land with wrong duration
   * metadata in its container (missing Cues), which throws off
   * both 'ended' timing and any code that trusts video.duration.
   * Seeking past the end and back is the standard fix: it forces
   * the browser to walk the file and recompute it properly. Skipped
   * when the duration already looks sane, since the seek is not
   * free on a long take.
   */
  _fixDuration(video) {
    if (Number.isFinite(video.duration) && video.duration > 0.5) return Promise.resolve();
    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        video.currentTime = 0;
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = 1e9;
      // Some browsers never fire 'seeked' for an out-of-range seek
      // on a broken-duration file; do not let developing hang on it.
      setTimeout(resolve, 1500);
    });
  }

  /** Render frames until the first real one lands, so the canvas is
   *  sized — picture plus both bars — before captureStream() locks a
   *  track to its dimensions. */
  _prime() {
    return new Promise((resolve) => {
      const attempt = () => {
        if (this.renderer.render(0)) resolve();
        else requestAnimationFrame(attempt);
      };
      attempt();
    });
  }

  /**
   * The stream MediaRecorder encodes.
   *
   * Clocked by hand where the engine allows it — captureStream(0)
   * emits nothing until requestFrame() asks, and _tick() asks
   * exactly once per graded frame. That one-to-one guarantee is the
   * point. Given a frame rate instead, the capture runs on its own
   * 30Hz clock while the grade runs on the raw take's, and two
   * independent 30Hz clocks beat against each other: periodically
   * the capture samples a canvas nothing has redrawn (a duplicated
   * frame) and then misses one that was (a dropped frame). Neither
   * clock is late — the footage still stutters, and it stutters
   * most visibly on exactly the fast movement that makes a repeated
   * frame obvious.
   *
   * Falling back to a fixed rate is only for engines with no
   * requestFrame at all, where a beat is better than no frames.
   */
  _captureStream(fps) {
    const canvas = this.exportCanvas;
    const manual = typeof window.CanvasCaptureMediaStreamTrack !== 'undefined' &&
                   typeof window.CanvasCaptureMediaStreamTrack.prototype.requestFrame === 'function';
    const stream = canvas.captureStream(manual ? 0 : fps);
    const track = stream.getVideoTracks()[0];
    this._captureTrack = (manual && typeof track?.requestFrame === 'function') ? track : null;
    return stream;
  }

  /**
   * The audio track for the final recording.
   *
   * `video.captureStream().getAudioTracks()` was the original
   * approach and is what silently dropped sound on every developed
   * export: WebKit's audio track from a media element's
   * captureStream() is unreliable — present but dead, or simply
   * absent — once that element is being read from a second time
   * this way. Routing the element through the Web Audio graph
   * instead (MediaElementAudioSourceNode → MediaStreamAudioDestinationNode)
   * taps the actual decoded audio directly and holds up across
   * engines. captureStream() remains as a fallback for the rare
   * browser with no Web Audio API at all.
   */
  async _buildAudioTrack(video) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      try {
        this.audioCtx = new Ctx();
        await this.audioCtx.resume().catch(() => {});
        const source = this.audioCtx.createMediaElementSource(video);
        const dest = this.audioCtx.createMediaStreamDestination();
        source.connect(dest);
        const track = dest.stream.getAudioTracks()[0] || null;
        if (track) return track;
      } catch { /* fall through to captureStream() */ }
    }
    if (typeof video.captureStream !== 'function') return null;
    try { return video.captureStream().getAudioTracks()[0] || null; }
    catch { return null; }
  }

  /* =============================================================
     DRIVE — one grade + blit per raw frame, never a bare timer
     ============================================================= */
  _startPump() {
    this._driving = true;
    const v = this.sourceVideo;
    if (typeof v.requestVideoFrameCallback === 'function') {
      const step = (now, meta) => {
        if (!this._driving) return;
        this._tick(meta.mediaTime * 1000);
        this._rvfcHandle = v.requestVideoFrameCallback(step);
      };
      this._rvfcHandle = v.requestVideoFrameCallback(step);
    } else {
      const step = () => {
        if (!this._driving) return;
        this._tick(v.currentTime * 1000);
        this._rvfcHandle = requestAnimationFrame(step);
      };
      this._rvfcHandle = requestAnimationFrame(step);
    }
  }

  _stopPump() {
    this._driving = false;
    const v = this.sourceVideo;
    if (typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(this._rvfcHandle);
    else cancelAnimationFrame(this._rvfcHandle);
  }

  _tick(mediaMs) {
    if (!this.renderer.render(mediaMs)) return;
    // One graded frame, one encoded frame — see _captureStream().
    this._captureTrack?.requestFrame();
    this._gradedFrames++;

    // Progress is reported a few times a second, not thirty. The
    // develop pass has a real frame budget — decode, grade, blit and
    // encode all have to fit inside one frame interval or the
    // captured stream starts repeating frames, which is precisely the
    // stutter this is meant to avoid — and rewriting a percentage
    // into the DOM every frame spends part of that budget on style
    // and layout work nobody can read at 30Hz anyway.
    const now = performance.now();
    if (now - this._lastProgressAt >= PROGRESS_INTERVAL_MS) {
      this._lastProgressAt = now;
      this.onProgress?.(Math.min(1, mediaMs / this._durationMs));
    }

    // The authoritative stop signal is the duration the *live*
    // Recorder measured with its own high-resolution timer when the
    // take was shot — not this offscreen video's self-reported
    // duration or its 'ended' event, either of which can be wrong
    // for a source with imperfect container metadata. 'ended' and
    // the maxMs timer in _run() remain as backups.
    if (mediaMs >= this._durationMs) this._finish();
  }

  _finish() {
    this._stopPump();
    this.onProgress?.(1);   // the throttle above may never have hit 100
    this.recorder.stop('done');
  }

  _onRecorderStop({ blob, mimeType, durationMs }) {
    const width = this.exportCanvas.width;
    const height = this.exportCanvas.height;
    // How many frames a second the lab actually managed. The raw
    // take plays back in real time, so anything meaningfully under
    // FORMAT.FPS means the grade could not keep up with the footage
    // and frames went past ungraded — the one failure mode that
    // shows up as judder in the finished film rather than as an
    // error. Reported rather than hidden so the caller can say so.
    const elapsed = performance.now() - this._gradingStartedAt;
    const developedFps = elapsed > 0 ? (this._gradedFrames * 1000) / elapsed : 0;
    this._cleanup();
    if (this._cancelled) return;
    this._resolveFinal?.({ blob, mimeType, durationMs, width, height, developedFps });
  }

  /* =============================================================
     BACKGROUNDING — see main.js. A stalled offscreen video should
     not spend real encode time on a frozen frame while hidden.
     ============================================================= */
  pauseForBackground() {
    try { this.sourceVideo.pause(); } catch { /* ignore */ }
    this.recorder.pause();
  }

  resumeFromBackground() {
    if (!this.sourceVideo.src) return;
    this.recorder.resume();
    this.audioCtx?.resume().catch(() => {});
    this.sourceVideo.play().catch(() => {});
  }

  /* =============================================================
     CLEANUP
     ============================================================= */
  _cleanup() {
    this._stopPump();
    if (this._rawURL) { URL.revokeObjectURL(this._rawURL); this._rawURL = null; }
    try { this.sourceVideo.pause(); } catch { /* ignore */ }
    this.sourceVideo.removeAttribute('src');
    try { this.sourceVideo.load(); } catch { /* ignore */ }
    this.sourceVideo.remove();
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch { /* already gone */ }
      this.audioCtx = null;
    }
    if (this.renderer) {
      try { this.renderer.destroy(); } catch { /* already gone */ }
      this.renderer = null;
    }
    this._captureTrack = null;
  }

  /** Abort mid-development — the app backgrounded past recovery, or
   *  the operator navigated away. */
  cancel() {
    this._cancelled = true;
    try { this.recorder.stop('interrupt'); } catch { /* ignore */ }
    this._cleanup();
  }
}
