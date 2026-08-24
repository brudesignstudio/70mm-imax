/**
 * Photographer.js
 * ---------------------------------------------------------------
 * One frame, through the same bench a take goes through.
 *
 * A still is the develop pass with the time axis taken out: the
 * live viewfinder video is the source instead of a replayed
 * recording, the grade runs once instead of per frame, and the
 * result is read straight off the canvas as a JPEG rather than
 * re-encoded through MediaRecorder. Same FilmRenderer, same grade,
 * same border art — so a photo and a frame of a take of the same
 * scene come out of the lab looking like they came off the same
 * roll, which is the whole point of shooting stills in here.
 *
 * The renderer is built once and reused across exposures. Compiling
 * the shader chain costs real milliseconds, and a photo mode is
 * used in bursts — paying that on every shutter press would put a
 * visible hitch between the tap and the frame.
 *
 * Deliberately absent: the shutter blend (it integrates this frame
 * against the previous one, and a still has no previous frame) and
 * the steadicam (it smooths a path over time, and a still has no
 * path — switching it on would only cost overscan, cropping the
 * frame for nothing).
 */

import { FORMAT, PHOTO } from '../config.js';
import { loadFilmStripImage } from '../utils/filmstrip.js';
import { FilmRenderer } from './FilmRenderer.js';

export class Photographer {
  /**
   * @param {object} opts { look, quality, digitalZoom }
   *   look        the live LOOK object from Settings (grade to apply)
   *   quality     QUALITY tier key
   *   digitalZoom baked-in crop zoom, matching the viewfinder (1 = none)
   */
  constructor({ look, quality = 'high', digitalZoom = 1 } = {}) {
    this.look = look;
    this.quality = quality;
    this.digitalZoom = digitalZoom;

    this.canvas = document.createElement('canvas');
    this.renderer = null;
    this._ready = null;
  }

  /** Build the bench on first use, then hold it for later frames. */
  async _prepare() {
    if (this.renderer) return;
    if (!this._ready) {
      this._ready = (async () => {
        const strip = await loadFilmStripImage();
        const renderer = new FilmRenderer(this.canvas, this.look);
        renderer.setQuality(this.quality);
        renderer.setFilmStrip(strip);
        renderer.setDigitalZoom(this.digitalZoom);
        renderer.setSteady(false);   // no path to smooth on a still
        this.renderer = renderer;
      })();
    }
    await this._ready;
  }

  /** Settings can change between exposures; the bench outlives them. */
  setLook(look) {
    this.look = look;
    this.renderer?.setLook(look);
  }

  setQuality(tier) {
    this.quality = tier;
    this.renderer?.setQuality(tier);
  }

  setDigitalZoom(z) {
    this.digitalZoom = z;
    this.renderer?.setDigitalZoom(z);
  }

  /**
   * Expose one frame from a live <video>.
   *
   * @param {HTMLVideoElement} video  the viewfinder feed
   * @returns {Promise<{ blob: Blob, mimeType: string, width: number, height: number }>}
   */
  async capture(video) {
    if (!video || video.readyState < 2) {
      throw new Error('The viewfinder is not ready yet.');
    }
    await this._prepare();

    const r = this.renderer;
    r.setSource(video);
    // Synced to a random point on the film's own clock rather than
    // to wall time, so grain and gate registration differ from one
    // exposure to the next — see PHOTO.PHASE_SPREAD_S.
    r.startedAt = 0;
    const phase = Math.random() * PHOTO.PHASE_SPREAD_S * 1000;

    // setSource() forces a resize on the next frame, and the first
    // render after it also has to allocate and fill both video
    // textures before the composite reads one. Render until a frame
    // actually lands rather than assuming the first attempt does.
    await this._renderFrame(phase);

    const blob = await new Promise((resolve) => {
      try { this.canvas.toBlob((b) => resolve(b || null), PHOTO.MIME, PHOTO.QUALITY); }
      catch { resolve(null); }
    });
    if (!blob) throw new Error('The frame could not be read off the bench.');

    return {
      blob,
      mimeType: PHOTO.MIME,
      width: this.canvas.width,
      height: this.canvas.height,
    };
  }

  /** Drive render() until it reports a real frame, or give up. */
  _renderFrame(t) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        if (!this.renderer) return reject(new Error('The bench was torn down mid-exposure.'));
        if (this.renderer.render(t)) return resolve();
        if (++tries > FORMAT.FPS) return reject(new Error('The viewfinder did not deliver a frame.'));
        requestAnimationFrame(attempt);
      };
      attempt();
    });
  }

  destroy() {
    if (this.renderer) {
      try { this.renderer.destroy(); } catch { /* already gone */ }
      this.renderer = null;
    }
    this._ready = null;
  }
}
