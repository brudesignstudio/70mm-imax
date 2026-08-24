/**
 * filmstrip.js
 * ---------------------------------------------------------------
 * The border artwork, loaded once for the whole session.
 *
 * Both capture paths composite the same frame around the picture —
 * the develop pass on a video take, and the photo path on a single
 * still — and it is a static asset either way, so it is fetched
 * once and the same decoded <img> is handed to every renderer that
 * asks. Shared here rather than owned by either caller, since
 * neither has a better claim to it than the other.
 */

import { EXPORT_FRAME } from '../config.js';

let _promise = null;

/** @returns {Promise<HTMLImageElement>} */
export function loadFilmStripImage() {
  if (!_promise) {
    _promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The film-strip artwork failed to load.'));
      img.src = EXPORT_FRAME.image;
    });
  }
  return _promise;
}
