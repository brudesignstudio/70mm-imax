/**
 * Recorder.js
 * ---------------------------------------------------------------
 * MediaRecorder over an arbitrary video source, described by a
 * small adapter: `{ supported, getStream(fps) }`.
 *
 * Two adapters use this in the app: one wraps the raw camera
 * MediaStream (shooting — zero rendering cost, closest thing to the
 * stock Camera app), the other wraps the compositor canvas that
 * developing draws the graded, sprocketed frame onto. Same class,
 * same 3-minute enforcement, same finalise path, because both are
 * fundamentally "record whatever this source is producing right
 * now" — see utils for the two adapters.
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
   * @param {{ supported?: boolean, stopTracksOnFinish?: boolean, getStream: (fps:number) => MediaStream }} source
   *   stopTracksOnFinish defaults true (correct for a canvas capture
   *   track); the raw-camera adapter sets it false so finishing a
   *   recording does not stop the live camera track.
   * @param {object} handlers   { onTick, onStop, onError, onStart }
   */
  constructor(source, handlers = {}) {
    this.source = source;
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
    return typeof MediaRecorder !== 'undefined' && this.source.supported !== false;
  }

  /** MP4 is the only container iOS will accept into Photos. */
  get isMP4() { return (this.mimeType || '').includes('mp4'); }

  /* =============================================================
     START
     ============================================================= */
  async start({ audioTrack = null, fps = 30, videoBitsPerSecond = RECORDING.VIDEO_BPS, maxMs = RECORDING.MAX_MS } = {}) {
    if (this.state !== 'idle') return false;
    if (!this.supported) throw new Error('This browser cannot record this source.');

    // fps is only meaningful to a canvas source (captureStream pulls
    // frames on a fixed clock rather than only on draw calls, which
    // keeps the encoder's timebase stable even if a frame is
    // dropped); a live MediaStream source ignores it.
    const sourceStream = this.source.getStream(fps);
    this.stream = new MediaStream();
    sourceStream.getVideoTracks().forEach((t) => this.stream.addTrack(t));
    if (audioTrack && audioTrack.readyState === 'live') this.stream.addTrack(audioTrack);

    const options = {
      videoBitsPerSecond,
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
    this._maxMs = maxMs;

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
    this._limitTimer = setTimeout(() => this.stop('limit'), this._maxMs);
    // Braces: a tick that also enforces the ceiling, because mobile
    // browsers throttle timers in backgrounded tabs.
    this._tick();

    this.handlers.onStart?.({ mimeType: this.recorder.mimeType || this.mimeType });
    return true;
  }

  _tick = () => {
    if (this.state !== 'recording') return;
    this.elapsed = performance.now() - this.startedAt;
    if (this.elapsed >= this._maxMs) {
      this.elapsed = this._maxMs;
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
    this.elapsed = Math.min(performance.now() - this.startedAt, this._maxMs);
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

    // A canvas.captureStream() track is ours alone — ephemeral,
    // created fresh per recording — so it is safe and correct to
    // stop it here. A raw camera track is *not* ours: it is the
    // same live track the camera adapter keeps handing out, and
    // stopping it here would kill the viewfinder along with it. The
    // adapter says which case this is; canvas sources default to
    // "yes, stop it" since that was every existing call site.
    if (this.source.stopTracksOnFinish !== false) {
      this.stream?.getVideoTracks().forEach((t) => t.stop());
    }
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

  /**
   * Pause/resume the underlying encoder — used by the develop pass
   * when the app backgrounds, so a stalled offscreen video does not
   * spend minutes of encode time on a frozen frame. Live shooting
   * never calls this; a backgrounded take is stopped outright there
   * because the OS actually suspends the camera.
   */
  pause() {
    if (this.state === 'recording' && this.recorder?.state === 'recording') {
      try { this.recorder.pause(); } catch { /* not supported: keep recording */ }
    }
  }

  resume() {
    if (this.state === 'recording' && this.recorder?.state === 'paused') {
      try { this.recorder.resume(); } catch { /* ignore */ }
    }
  }
}
