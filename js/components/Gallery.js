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
import { saveVideo } from '../utils/share.js';
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
    this._urls = [];
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

    for (const take of takes) this.list.append(this._card(take));
    return takes.length;
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

    const img = el('img', {
      class: 'take__thumb',
      alt: `Take from ${slate(take.ts)}`,
      loading: 'lazy',
      src: thumbURL || '',
    });

    const card = el('article', { class: 'take' },
      img,
      el('div', { class: 'take__actions' },
        el('button', {
          type: 'button',
          'aria-label': 'Save take',
          html: ICON.save,
          onClick: async (e) => {
            e.stopPropagation();
            haptic('tick');
            const res = await saveVideo(take.blob, take.ts);
            if (res.cancelled) return;
            toast(res.method === 'share' ? 'Choose Save Video in the sheet.' : 'Downloaded.');
          },
        }),
        el('button', {
          type: 'button',
          'aria-label': 'Delete take',
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
        el('span', { text: `${clockPrecise(take.durationMs)} · ${bytes(take.blob?.size)}` }),
      ),
    );

    on(card, 'click', () => this.handlers.onOpen?.(take));
    return card;
  }

  _revoke() {
    this._urls.forEach((u) => URL.revokeObjectURL(u));
    this._urls = [];
  }

  destroy() { this._revoke(); }
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
