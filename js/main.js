/**
 * main.js — application controller
 * ---------------------------------------------------------------
 * Owns the state machine and wires the components together:
 *
 *   intro → (permission) → camera → record → processing → playback
 *                            ↑                               │
 *                            └───────────────────────────────┘
 *
 * There is exactly one rAF loop in the app. It renders the film
 * pipeline, feeds the histogram, and nothing else — recording is
 * driven off the canvas by captureStream(), so a dropped frame in
 * the UI never desynchronises the file.
 */

import { FORMAT, RECORDING, GATE_ORIENTATION, ROTATE_PROMPT } from './config.js';
import { $, on, toast } from './utils/dom.js';
import { clock, clamp } from './utils/format.js';
import { has, isSecure, isIOS, report, pickMimeType } from './utils/capabilities.js';
import { haptic, setHapticsEnabled } from './utils/haptics.js';
import { putTake, deleteTake, storageEstimate } from './utils/storage.js';

import { CameraManager } from './components/CameraManager.js';
import { FilmRenderer } from './components/FilmRenderer.js';
import { Recorder } from './components/Recorder.js';
import { OrientationGuard } from './components/OrientationGuard.js';
import { Histogram } from './components/Histogram.js';
import { Playback } from './components/Playback.js';
import { Gallery, captureThumbnail } from './components/Gallery.js';
import { Settings } from './components/Settings.js';
import { GateFit } from './components/GateFit.js';

class App {
  constructor() {
    this.app = $('#app');
    this.source = $('#source');
    this.canvas = $('#preview');

    this.screen = null;   // set by show(); starts null so the first
                          // show('intro') is not treated as a no-op
    this.wakeLock = null;
    this.rafId = 0;
    this.pendingTake = null;
    this.evPath = 'hardware';

    this.settings = new Settings({
      onLookChange: (look) => this.renderer?.setLook(look),
      onPrefsChange: (prefs) => this.applyPrefs(prefs),
    });

    this.camera = new CameraManager();
    this.renderer = null;
    this.recorder = null;
    this.histogram = null;

    // The gate's shape drives the layout and the orientation the
    // operator is held to; both come from FORMAT.ASPECT.
    this.app.setAttribute('data-gate', GATE_ORIENTATION);
    $('.rotate__text').textContent = ROTATE_PROMPT;
    $('#tag-format').textContent = `${FORMAT.LABEL} · 70MM`;
    $('#pb-meta').textContent = `${FORMAT.LABEL} · 70MM`;

    this.gateFit = new GateFit().attachAll();
    this.orientation = new OrientationGuard((o) => this.onOrientation(o), GATE_ORIENTATION);

    this.gallery = new Gallery({
      onOpen: (take) => this.openTake(take),
      onCountChange: () => {},
    });

    this.playback = new Playback({
      onExit: () => this.showCamera(),
      onDelete: (take) => this.discardTake(take),
      onSaved: () => {},
    });

    this.bind();
    this.renderIntro();
  }

  /* =============================================================
     SCREENS
     ============================================================= */
  show(name) {
    if (this.screen === name) return;
    this.screen = name;
    this.app.setAttribute('data-screen', name);
    for (const section of document.querySelectorAll('.screen')) {
      section.classList.toggle('is-active', section.id === `screen-${name}`);
    }
    // A hidden stage measures 0×0, so the gate on the screen we
    // just revealed has to be re-fitted now that it has a box.
    requestAnimationFrame(() => this.gateFit.measure());
  }

  /* =============================================================
     INTRO
     ============================================================= */
  renderIntro() {
    this.show('intro');

    const mime = pickMimeType(RECORDING.MIME_CANDIDATES);
    const list = $('#caps-list');
    list.textContent = '';
    for (const row of report(mime)) {
      const li = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = row.label;
      const state = document.createElement('span');
      state.className = row.ok ? 'ok' : (row.note ? 'meh' : 'no');
      state.textContent = row.note || (row.ok ? 'ready' : 'unavailable');
      li.append(name, state);
      list.append(li);
    }

    // Hard stops get said up front rather than failing at the shutter.
    const blockers = [];
    if (!isSecure) blockers.push('This page must be served over HTTPS for the camera to work.');
    if (!has.getUserMedia) blockers.push('This browser does not give web pages camera access.');
    if (!has.webgl) blockers.push('WebGL is unavailable, so the film pipeline cannot run.');
    if (!has.mediaRecorder || !has.captureStream) {
      blockers.push('This browser cannot record video; you can still use the viewfinder.');
    }
    if (blockers.length) {
      $('#intro-note').textContent = blockers.join(' ');
      if (!has.getUserMedia || !has.webgl || !isSecure) $('#btn-begin').disabled = true;
    }
  }

  /* =============================================================
     EVENT WIRING
     ============================================================= */
  bind() {
    on($('#btn-begin'), 'click', () => this.begin());
    on($('#btn-record'), 'click', () => this.toggleRecord());
    on($('#btn-settings'), 'click', () => this.settings.open());
    on($('#btn-fullscreen'), 'click', () => this.toggleFullscreen());

    on($('#btn-gallery'), 'click', async () => {
      await this.gallery.refresh();
      this.show('gallery');
    });
    on($('#btn-gallery-close'), 'click', () => {
      this.show(this.pendingTake ? 'playback' : 'camera');
    });

    // Tap to focus, anywhere inside the gate.
    on($('#frame'), 'click', (e) => this.focusAt(e));

    // Exposure compensation.
    const ev = $('#ev');
    on(ev, 'input', () => this.setExposure(parseFloat(ev.value)));

    on($('#btn-torch'), 'click', () => this.toggleTorch());
    on($('#btn-ae'), 'click', (e) => this.toggleLock(e.currentTarget, 'exposure'));
    on($('#btn-awb'), 'click', (e) => this.toggleLock(e.currentTarget, 'whiteBalance'));

    /* --- lifecycle ------------------------------------------- */
    // A backgrounded tab has its camera suspended by the OS; a take
    // that continues would record frozen frames, so we close it out.
    on(document, 'visibilitychange', () => {
      if (document.hidden) {
        if (this.recorder?.isRecording) {
          this.recorder.stop('interrupt');
          toast('Recording stopped — the app went to the background.');
        }
        this.releaseWakeLock();
      } else if (this.screen === 'camera') {
        this.requestWakeLock();
        this.source?.play?.().catch(() => {});
        // The OS cuts the LED when the camera is suspended, so the
        // torch has to be re-asserted or the button would lie.
        if (this.torchOn) this.camera.setTorch(true).catch(() => {});
      }
    });

    on(window, 'pagehide', () => this.recorder?.interruptIfRecording());

    // WebGL contexts are evicted under memory pressure on mobile.
    on(this.canvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      toast('Graphics context lost — reloading the viewfinder.');
      this.recorder?.interruptIfRecording();
    });
    on(this.canvas, 'webglcontextrestored', () => {
      try { this.rebuildRenderer(); }
      catch { toast('The viewfinder could not be restored — please reload.'); }
    });
  }

  /* =============================================================
     START THE CAMERA
     ============================================================= */
  async begin() {
    const button = $('#btn-begin');
    button.disabled = true;
    button.querySelector('span').textContent = 'Opening…';

    try {
      const stream = await this.camera.open({ withAudio: this.settings.prefs.audio });

      this.source.srcObject = stream;
      this.source.muted = true;             // never monitor: instant feedback loop
      await this.source.play().catch(() => {});

      this.rebuildRenderer();

      this.recorder = new Recorder(this.canvas, {
        onStart: () => this.onRecordStart(),
        onTick: (ms) => this.onRecordTick(ms),
        onStop: (result) => this.onRecordStop(result),
        onError: (err) => {
          this.setRecordingUI(false);
          toast(err.message || 'Recording failed.');
        },
      });

      this.configureCameraControls();
      this.applyPrefs(this.settings.prefs);
      await this.gallery.refresh();

      this.show('camera');
      this.requestWakeLock();
      this.startLoop();
      this.updateShutterState();
      this.warnIfStorageTight();
    } catch (err) {
      button.disabled = false;
      button.querySelector('span').textContent = 'Open Camera';
      $('#intro-note').textContent = err.message || 'The camera could not be opened.';
      toast(err.message || 'The camera could not be opened.');
    }
  }

  /**
   * Build the renderer, or re-point the existing one at a new
   * source. A canvas only ever yields one WebGL context, so an
   * intact renderer is always reused — a fresh FilmRenderer is
   * only built on first run or after a genuine context loss.
   */
  rebuildRenderer() {
    if (this.renderer && !this.renderer.isLost) {
      this.renderer.setSource(this.source);
      this.renderer.setLook(this.settings.look);
      this.renderer.setQuality(this.settings.prefs.quality);
    } else {
      try { this.renderer?.destroy?.(); } catch { /* already gone */ }
      this.renderer = new FilmRenderer(this.canvas, this.settings.look);
      this.renderer.setSource(this.source);
      this.renderer.setQuality(this.settings.prefs.quality);
    }
    this.histogram ??= new Histogram($('#histogram'), this.canvas);
    this.histogram.setEnabled(this.settings.prefs.histogram);
    if (!this.rafId) this.startLoop();
  }

  /** Show only the controls this platform can actually honour. */
  configureCameraControls() {
    const s = this.camera.supports;
    $('#btn-ae').hidden = !s.exposureMode;
    $('#btn-awb').hidden = !s.whiteBalanceMode;

    // The flash always shows; it is struck through where the
    // platform has no torch constraint (every iPhone, today).
    const torch = $('#btn-torch');
    torch.classList.toggle('is-unavailable', !s.torch);
    torch.setAttribute('aria-pressed', 'false');
    this.torchOn = false;

    this.evPath = s.exposureCompensation ? 'hardware' : 'digital';
    $('#ev-wrap').title = this.evPath === 'hardware'
      ? 'Sensor exposure compensation'
      : 'Digital exposure (this browser does not expose sensor exposure control)';

  }

  /** The gate size is only known after the first frame is sized. */
  updateFormatTag() {
    const w = this.renderer?.width;
    if (!w || w === this._taggedWidth) return;
    this._taggedWidth = w;
    $('#tag-format').textContent = `${FORMAT.LABEL} · ${w}×${this.renderer.height}`;
  }

  applyPrefs(prefs) {
    setHapticsEnabled(prefs.haptics);
    this.renderer?.setQuality(prefs.quality);
    this.histogram?.setEnabled(prefs.histogram);
  }

  async warnIfStorageTight() {
    const est = await storageEstimate();
    if (!est || !est.quota) return;
    const free = est.quota - (est.usage || 0);
    // A 3-minute take at 12 Mbps is roughly 270 MB.
    if (free < 400 * 1024 * 1024) {
      toast('Storage is low — a full three-minute magazine may not fit.', 4200);
    }
  }

  /* =============================================================
     RENDER LOOP
     ============================================================= */
  startLoop() {
    if (this.rafId) return;
    const tick = (now) => {
      this.rafId = requestAnimationFrame(tick);
      if (!this.renderer) return;
      if (this.renderer.render(now)) {
        this.histogram?.update(now);
        this.updateFormatTag();
        if (this.settings.isOpen) this.updateReadout();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopLoop() {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  updateReadout() {
    if (!this._readoutAt || performance.now() - this._readoutAt > 500) {
      this._readoutAt = performance.now();
      const r = this.camera.resolution;
      this.settings.setReadout(
        `Sensor ${r.width}×${r.height} @ ${r.frameRate}fps · ` +
        `Gate ${this.renderer.width}×${this.renderer.height} · ` +
        `${this.renderer.fps}fps render · ` +
        `EV path: ${this.evPath}`
      );
    }
  }

  /* =============================================================
     ORIENTATION
     ============================================================= */
  onOrientation(o) {
    const ok = o === GATE_ORIENTATION;
    this.app.setAttribute('data-orientation', o);
    // One flag drives the lockout, the preview blur and the
    // shutter, so the layout never has to know which orientation
    // this particular gate happens to need.
    this.app.setAttribute('data-gate-ok', ok ? 'true' : 'false');
    this.updateShutterState();

    // Rotating mid-take would change the sensor's frame geometry
    // under the encoder, so the take is closed out cleanly instead.
    if (!ok && this.recorder?.isRecording) {
      this.recorder.stop('interrupt');
      haptic('error');
      toast(`Recording stopped — the camera left ${GATE_ORIENTATION}.`);
    }
  }

  updateShutterState() {
    const btn = $('#btn-record');
    const ready = !!this.orientation?.isReady &&
                  !!this.renderer &&
                  !!this.recorder?.supported;
    btn.disabled = !ready;
    btn.setAttribute('aria-label',
      this.recorder?.isRecording ? 'Stop recording'
      : ready ? 'Start recording'
      : `Rotate to ${GATE_ORIENTATION} to record`);
  }

  /* =============================================================
     RECORDING
     ============================================================= */
  async toggleRecord() {
    if (!this.recorder) return;
    if (this.recorder.isRecording) {
      this.recorder.stop('user');
      return;
    }
    if (!this.orientation.isReady) {
      toast(ROTATE_PROMPT);
      return;
    }

    // Stretch goals, all best-effort and all silent on failure:
    // fullscreen first (Chrome requires it before an orientation
    // lock will be accepted), then the lock, then the wake lock.
    await this.enterFullscreen().catch(() => {});
    await this.orientation.lock().catch(() => {});
    this.requestWakeLock();

    try {
      await this.recorder.start({
        audioTrack: this.settings.prefs.audio ? this.camera.audioTrack : null,
        fps: FORMAT.FPS,
      });
    } catch (err) {
      toast(err.message || 'Recording could not start.');
    }
  }

  onRecordStart() {
    haptic('start');
    this.setRecordingUI(true);
    // The film moving through the gate belongs in the recording, so
    // gate mechanics switch on for the duration of the take.
    this.renderer.setGateLive(true);
    this.onRecordTick(0);
  }

  onRecordTick(ms) {
    const remaining = Math.max(0, RECORDING.MAX_MS - ms);
    $('#timer').textContent = clock(ms);
    $('#remaining').textContent = clock(remaining);

    const pct = clamp(ms / RECORDING.MAX_MS, 0, 1);
    $('#magazine-fill').style.width = `${pct * 100}%`;
    // 283 ≈ the circumference of the r=45 progress ring.
    $('#shutter-progress').style.strokeDashoffset = String(283 * (1 - pct));

    // A short warning as the magazine runs out.
    if (remaining <= 10_000 && !this._warnedEnd) {
      this._warnedEnd = true;
      haptic('tick');
      toast('Ten seconds of magazine left.', 2000);
    }
  }

  async onRecordStop({ blob, mimeType, durationMs, reason }) {
    this.setRecordingUI(false);
    this.renderer.setGateLive(this.settings.prefs.gateWeaveLive);
    this._warnedEnd = false;
    haptic(reason === 'limit' ? 'limit' : 'stop');
    this.orientation.unlock();

    if (reason === 'limit') toast('Magazine complete — three minutes exposed.');

    if (!blob || blob.size < 1024) {
      toast('That take came back empty. Try again.');
      return;
    }

    this.show('processing');
    $('#processing-sub').textContent = 'Fixing the negative…';

    // Thumbnail comes from the live canvas, which still holds the
    // last graded frame of the take.
    const thumb = await captureThumbnail(this.canvas);

    const take = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      blob,
      mimeType,
      durationMs,
      width: this.renderer.width,
      height: this.renderer.height,
      thumb,
    };

    // Persist, but never lose the take if the quota rejects it —
    // the operator can still review and save it from memory.
    try {
      $('#processing-sub').textContent = 'Filing the magazine…';
      await putTake(take);
      await this.gallery.refresh();
    } catch {
      toast('Could not archive this take, but you can still save it.');
    }

    this.openTake(take);
  }

  setRecordingUI(on) {
    this.app.setAttribute('data-recording', on ? 'true' : 'false');
    this.updateShutterState();
    if (!on) {
      $('#timer').textContent = '00:00';
      $('#remaining').textContent = clock(RECORDING.MAX_MS);
      $('#magazine-fill').style.width = '0%';
      $('#shutter-progress').style.strokeDashoffset = '283';
    }
  }

  /* =============================================================
     PLAYBACK / GALLERY
     ============================================================= */
  openTake(take) {
    this.pendingTake = take;
    this.playback.load(take);
    this.show('playback');
    // Autoplay is permitted here: the take is muted-by-default only
    // if the browser insists, and this follows a user gesture.
    setTimeout(() => this.playback.play(), 260);
  }

  async discardTake(take) {
    try { await deleteTake(take.id); } catch { /* ignore */ }
    this.playback.unload();
    this.pendingTake = null;
    await this.gallery.refresh();
    toast('Take discarded.');
    this.showCamera();
  }

  showCamera() {
    this.playback.unload();
    this.pendingTake = null;
    this.show('camera');
    this.requestWakeLock();
    this.source?.play?.().catch(() => {});
  }

  /* =============================================================
     CAMERA CONTROLS
     ============================================================= */

  /**
   * Tap-to-focus. The tap is in gate coordinates; the sensor is
   * larger than the gate, so the point has to be mapped back
   * through the crop before the constraint means anything.
   */
  async focusAt(event) {
    if (this.screen !== 'camera' || !this.orientation.isReady) return;

    const frame = $('#frame');
    const rect = frame.getBoundingClientRect();
    const gx = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const gy = clamp((event.clientY - rect.top) / rect.height, 0, 1);

    // Reticle is drawn regardless — the operator gets confirmation
    // that the tap registered even where focus cannot be driven.
    const reticle = $('#reticle');
    reticle.style.left = `${gx * 100}%`;
    reticle.style.top = `${gy * 100}%`;
    reticle.classList.remove('is-active');
    void reticle.offsetWidth;
    reticle.classList.add('is-active');
    haptic('tick');

    const [sx, sy, ox, oy] = this.renderer.crop;
    const point = { x: ox + gx * sx, y: oy + gy * sy };

    const res = await this.camera.focusAt(point.x, point.y);
    if (!res.ok && res.reason === 'unsupported' && !this._focusWarned) {
      this._focusWarned = true;
      toast(isIOS
        ? 'iOS Safari does not expose manual focus to web pages — the camera stays on continuous autofocus.'
        : 'This camera does not expose focus control to the browser.', 4000);
    }
  }

  /**
   * Exposure compensation, hardware where possible.
   *
   * On iOS Safari the sensor constraint does not exist, so the same
   * number is applied as a linear-light gain before the tone curve
   * instead. It is not identical — a real stop changes what the
   * sensor collects — but applied pre-curve it rolls off through
   * the same shoulder rather than clipping, which is far closer
   * than a post-hoc brightness slider.
   */
  async setExposure(stops) {
    $('#ev-value').textContent = `${stops > 0 ? '+' : ''}${stops.toFixed(1)}`;

    const res = await this.camera.setExposureCompensation(stops);
    if (res.ok) {
      this.evPath = 'hardware';
      this.settings.look.exposure.ev = 0;
    } else {
      this.evPath = 'digital';
      this.settings.look.exposure.ev = stops;
      this.renderer?.setLook(this.settings.look);
    }
  }

  /**
   * Flash — a continuous torch, not a strobe.
   *
   * Limitation: there is no web API for a *photographic* flash. The
   * only lamp control the platform exposes is the MediaTrack
   * `torch` constraint, which switches the LED on and leaves it on;
   * Chrome on Android implements it, and iOS Safari does not
   * implement it at all. That suits this app anyway — a movie
   * camera wants a continuous light source, not a pop.
   *
   * The button stays visible where torch is unsupported, struck
   * through, and says why when tapped, rather than vanishing and
   * leaving the operator wondering where the flash went.
   */
  async toggleTorch() {
    const button = $('#btn-torch');
    const next = button.getAttribute('aria-pressed') !== 'true';

    const res = await this.camera.setTorch(next);
    if (!res.ok) {
      button.classList.add('is-unavailable');
      toast(isIOS
        ? 'iOS Safari does not give web pages control of the flash. Only a native app can light the LED.'
        : 'This camera does not expose its flash to the browser.', 4200);
      return;
    }

    button.setAttribute('aria-pressed', next ? 'true' : 'false');
    button.classList.remove('is-unavailable');
    this.torchOn = next;
    haptic('tick');
    if (next) toast('Flash on — it stays lit while you shoot.', 1800);
  }

  async toggleLock(button, kind) {
    const next = button.getAttribute('aria-pressed') !== 'true';
    const res = kind === 'exposure'
      ? await this.camera.setExposureLock(next)
      : await this.camera.setWhiteBalanceLock(next);

    if (!res.ok) {
      toast('This camera does not expose that lock to the browser.');
      return;
    }
    button.setAttribute('aria-pressed', next ? 'true' : 'false');
    haptic('tick');
    toast(`${kind === 'exposure' ? 'Exposure' : 'White balance'} ${next ? 'locked' : 'unlocked'}.`, 1400);
  }

  /* =============================================================
     FULLSCREEN + WAKE LOCK
     ============================================================= */
  async enterFullscreen() {
    // Limitation: iOS Safari on iPhone implements no Fullscreen API
    // for arbitrary elements — only <video>. Installing the PWA to
    // the home screen is the supported way to get a full-bleed,
    // chrome-free camera there, which is why the manifest sets
    // display: fullscreen.
    const target = document.documentElement;
    const request = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!request || document.fullscreenElement) return false;
    await request.call(target, { navigationUI: 'hide' });
    return true;
  }

  async toggleFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await exit?.call(document);
      this.orientation.unlock();
      return;
    }
    const ok = await this.enterFullscreen().catch(() => false);
    if (!ok) {
      toast(isIOS
        ? 'iOS does not allow full screen here. Add 70MM to your Home Screen for a full-bleed viewfinder.'
        : 'Full screen is unavailable in this browser.', 4200);
    } else {
      this.orientation.lock();
    }
  }

  async requestWakeLock() {
    if (!has.wakeLock || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch { this.wakeLock = null; }
  }

  releaseWakeLock() {
    try { this.wakeLock?.release(); } catch { /* ignore */ }
    this.wakeLock = null;
  }
}

/* ===============================================================
   BOOT
   =============================================================== */
window.addEventListener('DOMContentLoaded', () => {
  try {
    window.app = new App();
  } catch (err) {
    const note = document.getElementById('intro-note');
    if (note) note.textContent = err.message || 'This browser cannot run 70MM.';
  }
});

// Offline support. Registered after load so it never competes with
// the camera for bandwidth or main-thread time on first run.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is optional */ });
  });
}
