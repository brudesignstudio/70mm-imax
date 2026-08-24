/**
 * Gallery.js
 * ---------------------------------------------------------------
 * The shelf of exposed reels, persisted in IndexedDB so takes
 * survive a reload, an app-switch, or an offline session.
 *
 * Thumbnails are stored as JPEG blobs captured from the graded
 * canvas at the moment the take was made — decoding a frame out of
 * a 3-minute video just to draw a card would be wasteful.
 */

import { $, el, on, toast } from '../utils/dom.js';
import { clockPrecise, bytes, slate } from '../utils/format.js';
import { listTakes, deleteTake } from '../utils/storage.js';
import { saveMedia } from '../utils/share.js';
import { haptic } from '../utils/haptics.js';

const ICON = {
  save: '<svg viewBox="0 0 24 24"><path d="M12 3.5v11M7.5 10.5L12 15l4.5-4.5M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.8h6V7M6.5 7l1 12.2h9L17 7"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>',
};

export class Gallery {
  /** @param {object} handlers { onOpen, onCountChange } */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.list = $('#gallery-list');
    this.empty = $('#gallery-empty');
    this.badge = $('#gallery-count');
    this.button = $('#btn-gallery');
    this.buttonThumb = $('#gallery-thumb');
    this._urls = [];
    // Held apart from _urls: that lot is revoked wholesale on every
    // refresh, and this one has to outlive the rebuild — it is worn
    // by a button that stays on screen the whole time.
    this._buttonURL = null;
  }

  /** Read every take and rebuild the grid. */
  async refresh() {
    this._revoke();
    let takes = [];
    try { takes = await listTakes(); }
    catch { toast('Stored takes are unavailable in this browser.'); }

    this.list.textContent = '';
    this.empty.hidden = takes.length > 0;
    this._setBadge(takes.length);
    this._setButtonThumb(takes);

    for (const take of takes) this.list.append(this._card(take));
    return takes.length;
  }

  /**
   * Dress the gallery button in the most recent frame.
   *
   * takes arrive newest-first, but the newest one is not guaranteed
   * to *have* a thumbnail — captureThumbnail is best-effort and
   * deliberately never costs anyone a take — so this walks forward
   * to the first frame that actually carries one rather than
   * blanking the button over a missing image.
   */
  _setButtonThumb(takes) {
    if (!this.buttonThumb || !this.button) return;
    const latest = takes.find((t) => t.thumb);

    if (this._buttonURL) {
      URL.revokeObjectURL(this._buttonURL);
      this._buttonURL = null;
    }

    if (!latest) {
      this.buttonThumb.removeAttribute('src');
      this.buttonThumb.hidden = true;
      this.button.classList.remove('has-thumb');
      return;
    }

    this._buttonURL = URL.createObjectURL(latest.thumb);
    this.buttonThumb.src = this._buttonURL;
    this.buttonThumb.hidden = false;
    this.button.classList.add('has-thumb');
  }

  _setBadge(n) {
    if (!this.badge) return;
    this.badge.hidden = n === 0;
    this.badge.textContent = String(n);
    this.handlers.onCountChange?.(n);
  }

  _card(take) {
    const thumbURL = take.thumb ? URL.createObjectURL(take.thumb) : null;
    if (thumbURL) this._urls.push(thumbURL);

    const photo = take.kind === 'photo';

    const img = el('img', {
      class: 'take__thumb',
      alt: `${photo ? 'Photo' : 'Take'} from ${slate(take.ts)}`,
      loading: 'lazy',
      src: thumbURL || '',
    });

    const card = el('article', { class: 'take' },
      img,
      el('div', { class: 'take__actions' },
        el('button', {
          type: 'button',
          'aria-label': photo ? 'Save photo' : 'Save take',
          html: ICON.save,
          onClick: async (e) => {
            e.stopPropagation();
            haptic('tick');
            const res = await saveMedia(take.blob, take.ts);
            if (res.cancelled) return;
            toast('Shared');
          },
        }),
        el('button', {
          type: 'button',
          'aria-label': photo ? 'Delete photo' : 'Delete take',
          html: ICON.trash,
          onClick: async (e) => {
            e.stopPropagation();
            haptic('stop');
            await deleteTake(take.id);
            await this.refresh();
            toast('Take deleted.');
          },
        }),
      ),
      el('div', { class: 'take__meta' },
        el('span', { text: slate(take.ts) }),
        // A still has no running time; it says so instead of
        // reading "0:00.0", which looks like a take that failed.
        el('span', {
          text: `${photo ? 'STILL' : clockPrecise(take.durationMs)} · ${bytes(take.blob?.size)}`,
        }),
      ),
    );

    on(card, 'click', () => this.handlers.onOpen?.(take));
    return card;
  }

  _revoke() {
    this._urls.forEach((u) => URL.revokeObjectURL(u));
    this._urls = [];
  }

  destroy() {
    this._revoke();
    if (this._buttonURL) {
      URL.revokeObjectURL(this._buttonURL);
      this._buttonURL = null;
    }
  }
}

/**
 * Grab a JPEG still from the graded canvas for use as a card
 * thumbnail. Runs off the main capture path, so a failure here
 * never costs the operator a take.
 */
export function captureThumbnail(canvas, maxWidth = 480) {
  return new Promise((resolve) => {
    try {
      const scale = Math.min(1, maxWidth / canvas.width);
      const c = document.createElement('canvas');
      c.width = Math.max(2, Math.round(canvas.width * scale));
      c.height = Math.max(2, Math.round(canvas.height * scale));
      c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
      c.toBlob((blob) => resolve(blob || null), 'image/jpeg', 0.82);
    } catch { resolve(null); }
  });
}
