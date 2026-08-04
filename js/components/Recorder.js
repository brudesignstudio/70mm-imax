/**
 * Recorder.js
 * ---------------------------------------------------------------
 * Records the *graded* canvas, not the raw camera.
 *
 * canvas.captureStream() gives a live video track fed by whatever
 * the renderer last drew, so the file and the viewfinder are
 * guaranteed identical — there is no export-time re-grade, and a
 * 3-minute take costs nothing beyond the encode that was already
 * happening.
 *
 * The audio track is taken straight from getUserMedia and merged
 * into the same MediaStream so the container carries both.
 *
 * The 3-minute limit is enforced two ways: a timer, and a check on
 * every progress tick. Timers on mobile are throttled aggressively
 * when the page is backgrounded, so the tick is the one that
 * actually guarantees the ceiling.
 */

import { RECORDING } from '../config.js';
import { pickMimeType } from '../utils/capabilities.js';

export class Recorder {
  /**
   * @param {HTMLCanvasElement} canvas   the graded output canvas
   * @param {object} handlers            { onTick, onStop, onError, onStart }
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.handlers = handlers;

    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.mimeType = pickMimeType(RECORDING.MIME_CANDIDATES);

    this.state = 'idle';        // idle | recording | stopping
    this.startedAt = 0;
    this.elapsed = 0;
    this._raf = 0;
    this._limitTimer = 0;
    this._stopReason = null;
  }

  get isRecording() { return this.state === 'recording'; }

  /** True if this browser can produce a file at all. */
  get supported() {
    return typeof MediaRecorder !== 'undefined' &&
           typeof this.canvas.captureStream === 'function';
  }

  /** MP4 is the only container iOS will accept into Photos. */
  get isMP4() { return (this.mimeType || '').includes('mp4'); }

  /* =============================================================
     START
     ============================================================= */
  async start({ audioTrack = null, fps = 30 } = {}) {
    if (this.state !== 'idle') return false;
    if (!this.supported) throw new Error('This browser cannot record video from a canvas.');

    // Capture at the cadence we render at. Passing an fps argument
    // (rather than 0) makes the track pull frames on a fixed clock,
    // which keeps the encoder's timebase stable even if a rAF is
    // dropped — critical for a take that runs three minutes.
    const canvasStream = this.canvas.captureStream(fps);
    this.stream = new MediaStream();
    canvasStream.getVideoTracks().forEach((t) => this.stream.addTrack(t));
    if (audioTrack && audioTrack.readyState === 'live') this.stream.addTrack(audioTrack);

    const options = {
      videoBitsPerSecond: RECORDING.VIDEO_BPS,
      audioBitsPerSecond: RECORDING.AUDIO_BPS,
    };
    if (this.mimeType) options.mimeType = this.mimeType;

    try {
      this.recorder = new MediaRecorder(this.stream, options);
    } catch {
      // Bitrate or mime rejected — retry with the UA's own defaults.
      this.recorder = new MediaRecorder(this.stream);
      this.mimeType = this.recorder.mimeType || this.mimeType;
    }

    this.chunks = [];
    this._stopReason = null;

    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onerror = (e) => {
      this.state = 'idle';
      this._cancelClocks();
      this.handlers.onError?.(e.error || new Error('Recording failed.'));
    };
    this.recorder.onstop = () => this._finalise();

    this.recorder.start(RECORDING.TIMESLICE_MS);
    this.state = 'recording';
    this.startedAt = performance.now();
    this.elapsed = 0;

    // Belt: a timer for the normal case.
    this._limitTimer = setTimeout(() => this.stop('limit'), RECORDING.MAX_MS);
    // Braces: a tick that also enforces the ceiling, because mobile
    // browsers throttle timers in backgrounded tabs.
    this._tick();

    this.handlers.onStart?.({ mimeType: this.recorder.mimeType || this.mimeType });
    return true;
  }

  _tick = () => {
    if (this.state !== 'recording') return;
    this.elapsed = performance.now() - this.startedAt;
    if (this.elapsed >= RECORDING.MAX_MS) {
      this.elapsed = RECORDING.MAX_MS;
      this.handlers.onTick?.(this.elapsed);
      this.stop('limit');
      return;
    }
    this.handlers.onTick?.(this.elapsed);
    this._raf = requestAnimationFrame(this._tick);
  };

  _cancelClocks() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._limitTimer);
    this._raf = 0;
    this._limitTimer = 0;
  }

  /* =============================================================
     STOP
     @param {'user'|'limit'|'interrupt'} reason
     ============================================================= */
  stop(reason = 'user') {
    if (this.state !== 'recording') return false;
    this.state = 'stopping';
    this._stopReason = reason;
    this.elapsed = Math.min(performance.now() - this.startedAt, RECORDING.MAX_MS);
    this._cancelClocks();
    try {
      this.recorder.requestData?.();
      this.recorder.stop();
    } catch {
      this._finalise();
    }
    return true;
  }

  _finalise() {
    const mime = this.recorder?.mimeType || this.mimeType || 'video/webm';
    // Strip the codec parameters: Safari's <video> is fussier about
    // the type on a Blob URL than MediaRecorder is about producing it.
    const blobType = mime.split(';')[0];
    const blob = new Blob(this.chunks, { type: blobType });

    this.chunks = [];
    this.state = 'idle';

    // Release the canvas capture track; the camera stream itself
    // stays live so the operator can shoot again immediately.
    this.stream?.getVideoTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;

    this.handlers.onStop?.({
      blob,
      mimeType: blobType,
      durationMs: Math.round(this.elapsed),
      reason: this._stopReason || 'user',
    });
  }

  /** Called when the page is hidden mid-take. */
  interruptIfRecording() {
    if (this.isRecording) this.stop('interrupt');
  }
}
