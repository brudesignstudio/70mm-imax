/**
 * Playback.js
 * ---------------------------------------------------------------
 * Review of the take, still inside the gate.
 *
 * The recorded file is already cropped and already graded, so
 * playback is a plain <video> — no second render pass, no second
 * decode. The gate furniture stays on screen so review and capture
 * feel like the same instrument.
 */

import { FORMAT } from '../config.js';
import { $, on, toast } from '../utils/dom.js';
import { clock } from '../utils/format.js';
import { haptic } from '../utils/haptics.js';
import { saveVideo } from '../utils/share.js';

export class Playback {
  /** @param {object} handlers { onDelete, onExit, onSaved } */
  constructor(handlers = {}) {
    this.handlers = handlers;

    this.video = $('#player');
    this.timeEl = $('#pb-time');
    this.metaEl = $('#pb-meta');
    this.scrub = $('#scrub-fill');
    this.app = $('#app');

    this.take = null;
    this.objectURL = null;
    this._disposers = [];

    this._bind();
  }

  _bind() {
    const v = this.video;

    this._disposers.push(
      on($('#btn-playpause'), 'click', () => this.toggle()),
      on($('#btn-restart'), 'click', () => this.restart()),
      on($('#btn-delete'), 'click', () => this._delete()),
      on($('#btn-save'), 'click', () => this._save()),
      on($('#btn-back-camera'), 'click', () => this.handlers.onExit?.()),

      // Tapping the frame is the fastest play/pause on a phone.
      on($('.frame--playback'), 'click', (e) => {
        if (e.target.closest('button')) return;
        this.toggle();
      }),

      on(v, 'timeupdate', () => this._sync()),
      on(v, 'play',  () => this.app.setAttribute('data-playing', 'true')),
      on(v, 'pause', () => this.app.setAttribute('data-playing', 'false')),
      on(v, 'ended', () => {
        this.app.setAttribute('data-playing', 'false');
        this._sync();
      }),
      on(v, 'loadedmetadata', () => this._sync()),
    );
  }

  /**
   * @param {object} take { blob, mimeType, durationMs, ts, width, height }
   */
  load(take) {
    this.unload();
    this.take = take;
    this.objectURL = URL.createObjectURL(take.blob);
    this.video.src = this.objectURL;
    this.video.load();

    const dims = take.width ? `${take.width}×${take.height}` : FORMAT.LABEL;
    this.metaEl.textContent = `${dims} · 70MM`;
    this.timeEl.textContent = clock(0);
    this.scrub.style.width = '0%';
    this.app.setAttribute('data-playing', 'false');
  }

  unload() {
    try { this.video.pause(); } catch { /* ignore */ }
    this.video.removeAttribute('src');
    try { this.video.load(); } catch { /* ignore */ }
    if (this.objectURL) {
      URL.revokeObjectURL(this.objectURL);
      this.objectURL = null;
    }
    this.app.setAttribute('data-playing', 'false');
  }

  /* =============================================================
     TRANSPORT
     ============================================================= */
  async play() {
    try { await this.video.play(); }
    catch { toast('Tap the frame to play.'); }
  }

  pause() { this.video.pause(); }

  toggle() { this.video.paused ? this.play() : this.pause(); }

  restart() {
    this.video.currentTime = 0;
    this.play();
    haptic('tick');
  }

  _sync() {
    const v = this.video;
    // MediaRecorder output frequently reports Infinity for duration
    // until the file is fully buffered, so trust our own measured
    // take length and fall back to the element only if it is sane.
    const totalMs = (Number.isFinite(v.duration) && v.duration > 0)
      ? v.duration * 1000
      : (this.take?.durationMs || 0);
    const nowMs = v.currentTime * 1000;
    this.timeEl.textContent = clock(nowMs);
    this.scrub.style.width = totalMs ? `${Math.min(100, (nowMs / totalMs) * 100)}%` : '0%';
  }

  /* =============================================================
     ACTIONS
     ============================================================= */
  async _save() {
    if (!this.take) return;
    haptic('tick');
    const res = await saveVideo(this.take.blob, this.take.ts);
    if (res.cancelled) return;
    toast('Shared');
    this.handlers.onSaved?.(this.take, res);
  }

  _delete() {
    if (!this.take) return;
    haptic('stop');
    this.handlers.onDelete?.(this.take);
  }

  destroy() {
    this._disposers.forEach((d) => d());
    this.unload();
  }
}
