/**
 * OrientationGuard.js
 * ---------------------------------------------------------------
 * The gate has a fixed shape, so the phone has to be held one
 * particular way. The app refuses to expose the shutter until it
 * is. Which way that is comes from FORMAT.ASPECT — the guard is
 * told, it does not assume.
 *
 * Detection is viewport-first, deliberately:
 *   1. innerWidth vs innerHeight    — the shape the gate must fit
 *   2. matchMedia('(orientation: …)')
 *   3. screen.orientation.type      — tiebreaker only
 *
 * screen.orientation looks like the authoritative signal and is
 * not: it describes the *device*, not the window. In iPad Split
 * View, Stage Manager, an embedded web view, or any desktop
 * browser it happily reports "landscape-primary" while the page
 * itself is taller than it is wide. The gate has to fit the
 * viewport, so the viewport is what we ask.
 */

import { has } from '../utils/capabilities.js';

export class OrientationGuard {
  /**
   * @param {(o: 'landscape'|'portrait') => void} onChange
   * @param {'landscape'|'portrait'} required  the orientation the
   *        gate needs; derived from FORMAT.ASPECT by the caller.
   */
  constructor(onChange, required = 'landscape') {
    this.onChange = onChange;
    this.required = required;
    this.current = null;
    this._locked = false;

    this._mq = window.matchMedia('(orientation: landscape)');
    this._handler = () => this._evaluate();

    // Belt and braces: iOS fires resize but not always a matchMedia
    // change; Android fires orientationchange slightly before the
    // viewport settles, hence the rAF re-check.
    this._mq.addEventListener?.('change', this._handler);
    window.addEventListener('resize', this._handler, { passive: true });
    window.addEventListener('orientationchange', this._handler, { passive: true });
    screen.orientation?.addEventListener?.('change', this._handler);

    // Deferred one turn so the owner's constructor has finished
    // assigning this guard before the first callback arrives.
    this.current = this._detect();
    queueMicrotask(() => this.onChange?.(this.current));
  }

  _detect() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // A clear difference in either direction settles it outright.
    if (w && h && Math.abs(w - h) / Math.max(w, h) > 0.02) {
      return w > h ? 'landscape' : 'portrait';
    }
    if (this._mq.matches) return 'landscape';
    const type = screen.orientation?.type;
    if (type) return type.startsWith('landscape') ? 'landscape' : 'portrait';
    // A viewport too square to call: let the operator shoot rather
    // than block them on an ambiguous reading.
    return this.required;
  }

  _evaluate() {
    const next = this._detect();
    if (next === this.current) return;
    this.current = next;
    this.onChange?.(next);
    // Re-check after the viewport settles; some Android builds
    // report the pre-rotation size on the first event.
    requestAnimationFrame(() => {
      const settled = this._detect();
      if (settled !== this.current) {
        this.current = settled;
        this.onChange?.(settled);
      }
    });
  }

  /** Is the phone being held the way the gate needs? */
  get isReady() { return this.current === this.required; }

  get isLandscape() { return this.current === 'landscape'; }

  /* =============================================================
     ORIENTATION LOCK (stretch goal)
     ---------------------------------------------------------------
     Limitation: the Screen Orientation API's lock() requires
     fullscreen on Chrome/Android and is not implemented at all in
     iOS Safari. When it is unavailable we simply keep the guard
     running — if the operator rotates mid-take the recording is
     stopped rather than silently continuing in the wrong format.
     ============================================================= */
  async lock() {
    if (!has.orientationLock) return false;
    try {
      await screen.orientation.lock(this.required);
      this._locked = true;
      return true;
    } catch {
      return false;
    }
  }

  unlock() {
    if (!this._locked) return;
    try { screen.orientation.unlock(); } catch { /* ignore */ }
    this._locked = false;
  }

  destroy() {
    this._mq.removeEventListener?.('change', this._handler);
    window.removeEventListener('resize', this._handler);
    window.removeEventListener('orientationchange', this._handler);
    screen.orientation?.removeEventListener?.('change', this._handler);
    this.unlock();
  }
}
