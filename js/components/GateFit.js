/**
 * GateFit.js
 * ---------------------------------------------------------------
 * Sizes the gate in exact pixels, at whatever ratio
 * FORMAT.ASPECT specifies.
 *
 * Why not pure CSS: the obvious `aspect-ratio` + `vh` solution is
 * wrong on phones. `100vh` on iOS Safari is the *large* viewport —
 * the height the page would have if the URL bar were hidden — so
 * the gate is oversized while the bar is visible and jumps as it
 * collapses. `dvh` fixes the height but still cannot express
 * "fit a fixed-ratio box inside this box", because a width calculation
 * cannot reference the parent's resolved height.
 *
 * A ResizeObserver on the surround gives us both dimensions at
 * once and costs one layout read per resize. The gate is then
 * exact, on every device, at every moment — which matters when the
 * whole premise of the app is a specific frame ratio.
 */

import { FORMAT, EXPORT_ASPECT } from '../config.js';

/** A .stage can opt into a different fixed ratio than the default
 *  gate — e.g. a developed take's own aspect — via data-ratio. */
const RATIOS = { export: EXPORT_ASPECT };

export class GateFit {
  /** @param {number} ratio  default target aspect (width ÷ height) */
  constructor(ratio = FORMAT.ASPECT) {
    this.ratio = ratio;
    this.pairs = [];

    this._observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => this.measure())
      : null;

    if (!this._observer) {
      // Fallback for anything without ResizeObserver.
      window.addEventListener('resize', () => this.measure(), { passive: true });
      window.addEventListener('orientationchange', () => setTimeout(() => this.measure(), 120));
    }
  }

  /** Register every .stage / .frame pair in the document. A stage
   *  can carry data-ratio="export" (etc, see RATIOS) to fit its
   *  frame to something other than the default gate aspect. */
  attachAll() {
    this.pairs = Array.from(document.querySelectorAll('.stage'))
      .map((stage) => ({
        stage,
        frame: stage.querySelector('.frame'),
        ratio: RATIOS[stage.dataset.ratio] || this.ratio,
      }))
      .filter((p) => p.frame);
    this.pairs.forEach(({ stage }) => this._observer?.observe(stage));
    this.measure();
    return this;
  }

  measure() {
    for (const { stage, frame, ratio } of this.pairs) {
      // Hidden screens report 0×0; leave them until they are shown.
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      if (!cw || !ch) continue;

      const style = getComputedStyle(stage);
      const availW = cw - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const availH = ch - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (availW <= 0 || availH <= 0) continue;

      const widthLimited = availW / availH < ratio;
      const w = widthLimited ? availW : availH * ratio;
      const h = widthLimited ? availW / ratio : availH;

      frame.style.width = `${Math.floor(w)}px`;
      frame.style.height = `${Math.floor(h)}px`;
      frame.dataset.fitted = '1';
    }
  }

  destroy() {
    this._observer?.disconnect();
  }
}
