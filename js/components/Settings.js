/**
 * Settings.js
 * ---------------------------------------------------------------
 * Builds the "Stock & Lab" sheet from a schema so that adding a
 * tunable is a one-line change here, not a new control in HTML.
 *
 * Every slider writes straight into the live LOOK object, which the
 * next take's develop pass reads from directly — there is no live
 * shader to update on the spot any more, so a change here is seen
 * the next time a take is developed, not while framing. Values are
 * persisted as a sparse override map — only what the user actually
 * changed — so future revisions of the default negative still
 * reach them.
 */

import { el, $, on, toast } from '../utils/dom.js';
import { LOOK, PREFS, STORAGE, QUALITY } from '../config.js';
import { loadJSON, saveJSON, clearKey } from '../utils/storage.js';
import { has } from '../utils/capabilities.js';

/* --- path helpers --------------------------------------------- */
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const setPath = (obj, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
};

/** Deep clone that is enough for LOOK (plain objects, numbers, arrays). */
const clone = (o) => JSON.parse(JSON.stringify(o));

/* --- the sheet's contents -------------------------------------
   Ordered the way a colourist would work: exposure, then tone,
   then colour, then the artefacts. */
const SCHEMA = [
  {
    title: 'Shutter',
    controls: [
      { path: 'shutter.angle', label: 'Shutter angle', min: 0, max: 360, step: 5, decimals: 0, unit: '°',
        hint: 'A cine shutter is open for half of each frame — 180° — so movement smears between frames instead of freezing. At 0° you get the phone sensor\'s own thousandth-of-a-second stills, which is what makes video look like a run of photographs.' },
    ],
  },
  {
    title: 'Exposure & Lens',
    controls: [
      { path: 'exposure.ev', label: 'Exposure', min: -2, max: 2, step: 0.05, unit: ' EV', signed: true,
        hint: 'Applied in linear light before the tone curve, exactly where a stop belongs.' },
      { path: 'lens.aberration', label: 'Chromatic aberration', min: 0, max: 1, step: 0.01 },
      { path: 'lens.vignette', label: 'Vignette', min: 0, max: 0.6, step: 0.01 },
      { path: 'print.sharpen', label: 'Acutance', min: 0, max: 1, step: 0.01,
        hint: 'Contact-print edge contrast. Past ~0.5 it starts to look digital.' },
    ],
  },
  {
    title: 'Optical Scatter',
    controls: [
      { path: 'bloom.strength', label: 'Bloom', min: 0, max: 0.8, step: 0.01,
        hint: 'Neutral in-lens flare around speculars.' },
      { path: 'bloom.threshold', label: 'Bloom threshold', min: 0.3, max: 1, step: 0.01 },
      { path: 'halation.strength', label: 'Halation', min: 0, max: 1, step: 0.01,
        hint: 'The warm ring where light reflects off the film base back into the emulsion.' },
      { path: 'halation.radius', label: 'Halation spread', min: 0.4, max: 2.5, step: 0.05 },
    ],
  },
  {
    title: 'Tone',
    controls: [
      { path: 'tone.contrast', label: 'Print contrast', min: 0, max: 0.5, step: 0.01 },
      { path: 'tone.shoulder', label: 'Highlight rolloff', min: 0.05, max: 0.6, step: 0.01 },
      { path: 'tone.toe', label: 'Shadow toe', min: 0, max: 0.6, step: 0.01 },
      { path: 'tone.blackPoint', label: 'Black point', min: 0, max: 0.08, step: 0.002, decimals: 3 },
      { path: 'tone.shadowDensity', label: 'Base density', min: 0, max: 0.04, step: 0.001, decimals: 3,
        hint: 'Keeps blacks dense without letting them clip to absolute zero.' },
    ],
  },
  {
    title: 'Colour',
    controls: [
      { path: 'color.saturation', label: 'Saturation', min: 0.6, max: 1.6, step: 0.01 },
      { path: 'color.highlightDesat', label: 'Highlight desaturation', min: 0, max: 1, step: 0.01,
        hint: 'Dye layers give up colour as they approach clear film.' },
    ],
  },
  {
    title: 'Emulsion',
    controls: [
      { path: 'grain.strength', label: 'Grain', min: 0, max: 0.2, step: 0.002, decimals: 3,
        hint: '65mm negative is ten times the area of 35mm, so grain reads far finer.' },
      { path: 'grain.size', label: 'Grain size', min: 0.6, max: 4, step: 0.05 },
      { path: 'grain.chroma', label: 'Grain colour', min: 0, max: 1, step: 0.01 },
      { path: 'grain.shadowBias', label: 'Shadow grain', min: 0, max: 1, step: 0.01 },
      { path: 'grain.cadence', label: 'Grain cadence', min: 8, max: 30, step: 1, decimals: 0, unit: 'fps',
        hint: 'How often the grain re-rolls. Anything that does not divide the frame rate evenly makes the pattern hold for two frames now and then, which reads as a dropped frame — 30 is locked to the footage, 24 is the projected cadence with that pulse.' },
    ],
  },
  {
    title: 'Gate',
    controls: [
      { path: 'gate.weave', label: 'Weave', min: 0, max: 0.006, step: 0.0002, decimals: 4,
        hint: 'Lateral registration play. Real, and roughly a thousandth of the frame.' },
      { path: 'gate.breathing', label: 'Breathing', min: 0, max: 0.006, step: 0.0002, decimals: 4 },
    ],
  },
];

export class Settings {
  /**
   * @param {object} handlers { onLookChange, onPrefsChange }
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.sheet = $('#sheet-settings');
    this.body = $('#settings-body');
    this.scrim = $('#scrim');

    // Live look = defaults + stored overrides.
    this.overrides = loadJSON(STORAGE.LOOK_KEY, {});
    this.look = clone(LOOK);
    for (const [path, value] of Object.entries(this.overrides)) setPath(this.look, path, value);

    this.prefs = loadJSON(STORAGE.PREFS_KEY, PREFS);

    this._build();
    this._bindChrome();
  }

  /* =============================================================
     BUILD
     ============================================================= */
  _build() {
    this.body.textContent = '';
    this._valueNodes = new Map();

    /* --- capture group (preferences, not look) ---------------- */
    this.body.append(this._group('Capture', [
      this._segmented('Quality', Object.keys(QUALITY), this.prefs.quality, (v) => {
        this.prefs.quality = v;
        this._savePrefs();
      }, 'Halation is the expensive pass. Drop a tier if developing takes too long.'),

      this._switch(
        'Steadicam',
        this.prefs.steady !== false,
        (v) => { this.prefs.steady = v; this._savePrefs(); },
        'Smooths the camera path while developing, so a walking take glides instead of bouncing. Costs a slightly tighter frame — the correction has to slide the picture into margin cropped away for it.'
      ),

      this._switch('Live histogram', this.prefs.histogram, (v) => {
        this.prefs.histogram = v; this._savePrefs();
      }),

      this._switch(
        has.vibrate ? 'Haptics' : 'Haptics (visual tally)',
        this.prefs.haptics,
        (v) => { this.prefs.haptics = v; this._savePrefs(); },
        has.vibrate ? null : 'iOS Safari has no vibration API, so the tally flashes the gate instead.'
      ),
    ]));

    /* --- look groups ------------------------------------------ */
    for (const group of SCHEMA) {
      this.body.append(this._group(group.title, group.controls.map((c) => this._slider(c))));
    }

    /* --- readout ---------------------------------------------- */
    this.readout = el('p', { class: 'ctrl__hint', id: 'settings-readout' });
    this.body.append(this._group('Signal', [this.readout]));
  }

  _group(title, children) {
    return el('section', { class: 'group' },
      el('h3', { class: 'group__title', text: title }),
      ...children);
  }

  _slider(cfg) {
    const value = getPath(this.look, cfg.path);
    const decimals = cfg.decimals ?? 2;
    const fmt = (v) => `${cfg.signed && v > 0 ? '+' : ''}${Number(v).toFixed(decimals)}${cfg.unit || ''}`;

    const valueNode = el('span', { class: 'ctrl__val', text: fmt(value) });
    this._valueNodes.set(cfg.path, { node: valueNode, fmt });

    const input = el('input', {
      type: 'range',
      min: cfg.min, max: cfg.max, step: cfg.step,
      value,
      'aria-label': cfg.label,
    });

    on(input, 'input', () => {
      const v = parseFloat(input.value);
      setPath(this.look, cfg.path, v);
      valueNode.textContent = fmt(v);
      this.overrides[cfg.path] = v;
      saveJSON(STORAGE.LOOK_KEY, this.overrides);
      this.handlers.onLookChange?.(this.look);
    });

    return el('div', { class: 'ctrl' },
      el('div', { class: 'ctrl__head' },
        el('span', { class: 'ctrl__label', text: cfg.label }),
        valueNode),
      input,
      cfg.hint ? el('p', { class: 'ctrl__hint', text: cfg.hint }) : null);
  }

  _switch(label, initial, onToggle, hint) {
    const btn = el('button', {
      class: 'switch',
      type: 'button',
      'aria-pressed': initial ? 'true' : 'false',
    },
      el('span', { class: 'ctrl__label', text: label }),
      el('span', { class: 'switch__box' }));

    on(btn, 'click', () => {
      const next = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      onToggle(next);
    });

    return hint
      ? el('div', {}, btn, el('p', { class: 'ctrl__hint', text: hint }))
      : btn;
  }

  _segmented(label, options, initial, onPick, hint) {
    const buttons = options.map((opt) =>
      el('button', {
        type: 'button',
        text: opt,
        'aria-pressed': opt === initial ? 'true' : 'false',
        onClick: () => {
          buttons.forEach((b) => b.setAttribute('aria-pressed', 'false'));
          const i = options.indexOf(opt);
          buttons[i].setAttribute('aria-pressed', 'true');
          onPick(opt);
        },
      }));

    return el('div', { class: 'ctrl' },
      el('div', { class: 'ctrl__head' }, el('span', { class: 'ctrl__label', text: label })),
      el('div', { class: 'seg' }, ...buttons),
      hint ? el('p', { class: 'ctrl__hint', text: hint }) : null);
  }

  /* =============================================================
     CHROME
     ============================================================= */
  _bindChrome() {
    on($('#btn-settings-close'), 'click', () => this.close());
    on(this.scrim, 'click', () => this.close());
    on($('#btn-reset-look'), 'click', () => this.reset());
    on(window, 'keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  _savePrefs() {
    saveJSON(STORAGE.PREFS_KEY, this.prefs);
    this.handlers.onPrefsChange?.(this.prefs);
  }

  reset() {
    this.overrides = {};
    clearKey(STORAGE.LOOK_KEY);
    this.look = clone(LOOK);
    this._build();
    this.handlers.onLookChange?.(this.look);
    toast('Restored the 70mm reference negative.');
  }

  open() {
    this.scrim.hidden = false;
    requestAnimationFrame(() => {
      this.scrim.classList.add('is-open');
      this.sheet.classList.add('is-open');
    });
    this.sheet.setAttribute('aria-hidden', 'false');
  }

  close() {
    this.sheet.classList.remove('is-open');
    this.scrim.classList.remove('is-open');
    this.sheet.setAttribute('aria-hidden', 'true');
    setTimeout(() => { this.scrim.hidden = true; }, 320);
  }

  get isOpen() { return this.sheet.classList.contains('is-open'); }

  /** Live technical readout, refreshed by the app loop. */
  setReadout(text) {
    if (this.readout) this.readout.textContent = text;
  }
}
