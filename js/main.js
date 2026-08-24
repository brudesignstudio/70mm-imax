/**
 * main.js — application controller
 * ---------------------------------------------------------------
 * Owns the state machine and wires the components together:
 *
 *   intro → (permission) → camera → record → processing → playback
 *                            ↑                               │
 *                            └───────────────────────────────┘
 *
 * The camera screen runs no render loop at all: the viewfinder is
 * the raw <video> element, shown directly, so shooting costs the
 * browser nothing beyond decoding the camera feed — the same as any
 * other camera page. The film pipeline runs exactly once per take,
 * during "processing" — see components/Developer.js.
 */

import { FORMAT, RECORDING, SHOOT_ORIENTATION, ROTATE_PROMPT, ZOOM, GUIDE } from './config.js';
import { $, $$, on, toast } from './utils/dom.js';
import { clock, clamp } from './utils/format.js';
import { has, isSecure, isIOS, report, pickMimeType } from './utils/capabilities.js';
import { haptic, setHapticsEnabled } from './utils/haptics.js';
import { putTake, deleteTake, storageEstimate } from './utils/storage.js';

import { CameraManager } from './components/CameraManager.js';
import { coverCrop } from './components/FilmRenderer.js';
import { Recorder } from './components/Recorder.js';
import { Developer } from './components/Developer.js';
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

    this.screen = null;   // set by show(); starts null so the first
                          // show('intro') is not treated as a no-op
    this.wakeLock = null;
    this.pendingTake = null;
    this.evPath = 'hardware';
    this.zoomLevel = ZOOM.default;
    this._digitalZoomFactor = 1;   // baked into the develop pass; see setZoomLevel
    this.developer = null;         // the in-flight Developer, if any

    this.settings = new Settings({
      onLookChange: () => {},   // the grade only applies at develop time now
      onPrefsChange: (prefs) => this.applyPrefs(prefs),
    });

    this.camera = new CameraManager();
    this.recorder = null;
    this.histogram = null;

    // Two separate facts now. The picture is wide (FORMAT.ASPECT);
    // the phone is held upright (SHOOT_ORIENTATION). data-gate
    // carries the second one, because what the layout needs to know
    // is where the leftover screen is — and with a wide band on an
    // upright phone, that is above and below.
    this.app.setAttribute('data-gate', SHOOT_ORIENTATION);
    $('.rotate__text').textContent = ROTATE_PROMPT;
    $('#tag-format').textContent = `${FORMAT.LABEL} · 70 mm`;
    $('#pb-meta').textContent = `${FORMAT.LABEL} · 70 mm`;

    // The 16:9 guide sits where the fullscreen button used to.
    // Fullscreen was never much of a control — it does nothing at
    // all on iOS Safari, which implements no Fullscreen API for
    // arbitrary elements, and the shutter already asks for it
    // silently on every take (see toggleRecord).
    $('#guide-label').textContent = GUIDE.LABEL;
    this.setGuide(this.settings.prefs.guide === true);

    this.gateFit = new GateFit().attachAll();
    this.orientation = new OrientationGuard((o) => this.onOrientation(o), SHOOT_ORIENTATION);

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
    on($('#btn-settings'), 'click', () => { this.settings.open(); this.updateReadout(); });
    on($('#btn-guide'), 'click', () => {
      this.setGuide(!this._guideOn);
      haptic('tick');
      if (this._guideOn) toast(`${GUIDE.LABEL} guide on — anything outside the lines is lost to a widescreen crop.`, 2600);
    });

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

    for (const btn of $$('#zoom button')) {
      on(btn, 'click', () => this.setZoomLevel(parseFloat(btn.dataset.zoom)));
    }

    /* --- lifecycle ------------------------------------------- */
    // A backgrounded tab has its camera suspended by the OS; a take
    // that continues would record frozen frames, so we close it out.
    // Developing is not camera-bound, so it is paused instead.
    on(document, 'visibilitychange', () => {
      if (document.hidden) {
        if (this.recorder?.isRecording) {
          this.recorder.stop('interrupt');
          toast('Recording stopped — the app went to the background.');
        }
        this.developer?.pauseForBackground();
        this.releaseWakeLock();
      } else {
        if (this.screen === 'camera') {
          this.requestWakeLock();
          this.source?.play?.().catch(() => {});
          // The OS cuts the LED when the camera is suspended, so the
          // torch has to be re-asserted or the button would lie.
          if (this.torchOn) this.camera.setTorch(true).catch(() => {});
        }
        if (this.screen === 'processing') this.developer?.resumeFromBackground();
      }
    });

    on(window, 'pagehide', () => {
      this.recorder?.interruptIfRecording();
      this.developer?.cancel();
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
      const stream = await this.camera.open({ withAudio: true });

      this.source.srcObject = stream;
      this.source.muted = true;             // never monitor: instant feedback loop
      this.source.style.transform = '';
      await this.source.play().catch(() => {});

      this.recorder = new Recorder(
        { getStream: () => this.camera.stream, stopTracksOnFinish: false },
        {
          onStart: () => this.onRecordStart(),
          onTick: (ms) => this.onRecordTick(ms),
          onStop: (raw) => this.onRawRecordStop(raw),
          onError: (err) => {
            this.setRecordingUI(false);
            toast(err.message || 'Recording failed.');
          },
        }
      );

      this.histogram ??= new Histogram($('#histogram'), this.source);
      this.histogram.setEnabled(this.settings.prefs.histogram);

      this.zoomLevel = ZOOM.default;
      this._digitalZoomFactor = 1;
      this.updateZoomUI();

      await this.configureCameraControls();
      this.applyPrefs(this.settings.prefs);
      await this.gallery.refresh();

      this.show('camera');
      this.requestWakeLock();
      this.startHudLoop();
      this.updateShutterState();
      this.warnIfStorageTight();
    } catch (err) {
      button.disabled = false;
      button.querySelector('span').textContent = 'Open Camera';
      $('#intro-note').textContent = err.message || 'The camera could not be opened.';
      toast(err.message || 'The camera could not be opened.');
    }
  }

  /** Show only the controls this platform (and this lens) can
   *  actually honour. Re-run after every lens switch, not just once. */
  async configureCameraControls() {
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

    // 0.5× only exists where there is a genuine ultra-wide lens to
    // switch to — iOS reports one synthetic rear device, so this
    // stays hidden there rather than pretending.
    const half = $('#btn-zoom-05');
    if (half) half.hidden = !(await this.camera.findUltrawideDevice());
  }

  applyPrefs(prefs) {
    setHapticsEnabled(prefs.haptics);
    this.histogram?.setEnabled(prefs.histogram);
    this.setGuide(prefs.guide === true);
  }

  /**
   * The 16:9 framing guide.
   *
   * Two hairlines across the gate marking where a 16:9 camera
   * behind the same lens would have cut — full width, GUIDE.ASPECT
   * tall, centred. It is a viewfinder overlay and nothing else: it
   * is never composited into a frame, never recorded, and never
   * survives into a developed take, so a shot framed with it on and
   * a shot framed with it off come out of the lab identical.
   *
   * The geometry lives in CSS (--guide-band) rather than in JS
   * because the gate is already an exactly-measured box — the band
   * is a fixed percentage of it and does not need re-measuring when
   * the box changes size.
   */
  setGuide(on) {
    this._guideOn = !!on;
    this.app.setAttribute('data-guide', this._guideOn ? 'true' : 'false');
    const btn = $('#btn-guide');
    if (btn) btn.setAttribute('aria-pressed', this._guideOn ? 'true' : 'false');
    if (this.settings.prefs.guide !== this._guideOn) {
      this.settings.prefs.guide = this._guideOn;
      this.settings._savePrefs();
    }
  }

  async warnIfStorageTight() {
    const est = await storageEstimate();
    if (!est || !est.quota) return;
    const free = est.quota - (est.usage || 0);
    // A 3-minute take at 12 Mbps is roughly 270 MB.
    if (free < 400 * 1024 * 1024) {
      toast('Storage is low — a full three-minute reel may not fit.', 4200);
    }
  }

  /* =============================================================
     HUD LOOP — histogram sampling + the settings readout, both
     already self-throttled internally. Not a render loop: nothing
     here touches the picture, so there is no per-frame GPU cost to
     pause. It still steps aside when hidden, on principle.
     ============================================================= */
  startHudLoop() {
    if (this._hudTimer) return;
    this._hudTimer = setInterval(() => {
      if (document.hidden || this.screen !== 'camera') return;
      this.histogram?.update();
      if (this.settings.isOpen) this.updateReadout();
    }, 160);
  }

  updateReadout() {
    const r = this.camera.resolution;
    this.settings.setReadout(
      `Sensor ${r.width}×${r.height} @ ${r.frameRate}fps · ` +
      `Zoom ${this.zoomLevel}× · ` +
      `EV path: ${this.evPath}`
    );
  }

  /* =============================================================
     ORIENTATION
     ============================================================= */
  onOrientation(o) {
    const ok = o === SHOOT_ORIENTATION;
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
      toast('Recording stopped — the phone was turned on its side.');
    }
  }

  updateShutterState() {
    const btn = $('#btn-record');
    const ready = !!this.orientation?.isReady &&
                  !!this.camera?.videoTrack &&
                  !!this.recorder?.supported;
    btn.disabled = !ready;
    btn.setAttribute('aria-label',
      this.recorder?.isRecording ? 'Stop recording'
      : ready ? 'Start recording'
      : 'Hold the phone upright to record');
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
        audioTrack: this.camera.audioTrack,
        fps: FORMAT.FPS,
        videoBitsPerSecond: RECORDING.RAW_VIDEO_BPS,
      });
    } catch (err) {
      toast(err.message || 'Recording could not start.');
    }
  }

  onRecordStart() {
    haptic('start');
    this.setRecordingUI(true);
    this.onRecordTick(0);
  }

  onRecordTick(ms) {
    const remaining = Math.max(0, RECORDING.MAX_MS - ms);
    $('#timer').textContent = clock(ms);
    $('#remaining').textContent = clock(remaining);

    const pct = clamp(ms / RECORDING.MAX_MS, 0, 1);
    $('#reel-fill').style.width = `${pct * 100}%`;
    // 283 ≈ the circumference of the r=45 progress ring.
    $('#shutter-progress').style.strokeDashoffset = String(283 * (1 - pct));

    // A short warning as the reel runs out.
    if (remaining <= 10_000 && !this._warnedEnd) {
      this._warnedEnd = true;
      haptic('tick');
      toast('Ten seconds of reel left.', 2000);
    }
  }

  /** The raw take is done; developing turns it into the real one. */
  async onRawRecordStop({ blob, durationMs, reason }) {
    this.setRecordingUI(false);
    this._warnedEnd = false;
    haptic(reason === 'limit' ? 'limit' : 'stop');
    this.orientation.unlock();

    if (reason === 'limit') toast('Reel complete — three minutes exposed.');

    if (!blob || blob.size < 1024) {
      toast('That take came back empty. Try again.');
      return;
    }

    this.show('processing');
    await this.developTake({ blob, durationMs });
  }

  async developTake(rawTake) {
    const sub = $('#processing-sub');
    const progress = $('#processing-progress');
    sub.textContent = 'Developing…';
    progress.style.width = '0%';

    const developer = new Developer({
      look: this.settings.look,
      quality: this.settings.prefs.quality,
      digitalZoom: this._digitalZoomFactor,
      steady: this.settings.prefs.steady !== false,
      onProgress: (f) => {
        const pct = Math.round(f * 100);
        progress.style.width = `${pct}%`;
        sub.textContent = `Developing… ${pct}%`;
      },
    });
    this.developer = developer;

    developer.exportCanvas.className = 'frame__canvas';
    $('#develop-frame').replaceChildren(developer.exportCanvas);
    requestAnimationFrame(() => this.gateFit.measure());

    let result;
    try {
      result = await developer.develop(rawTake);
    } catch (err) {
      this.developer = null;
      toast(err.message || 'Developing failed — the raw take could not be processed.');
      this.showCamera();
      return;
    }

    sub.textContent = 'Filing the reel…';
    const thumb = await captureThumbnail(developer.exportCanvas);
    this.developer = null;

    // The lab reports how many frames a second it actually managed.
    // The raw take replays in real time, so falling meaningfully
    // short of FORMAT.FPS means frames went past ungraded and the
    // finished film will judder — the one failure here that is
    // invisible until you watch it back. Say so, with the lever
    // that fixes it, rather than letting it read as a bad camera.
    if (result.developedFps && result.developedFps < FORMAT.FPS * 0.85) {
      toast(
        `The lab ran at ${Math.round(result.developedFps)}fps of ${FORMAT.FPS} — ` +
        'lower Quality in Settings for smoother motion.', 5200);
    }

    const take = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      blob: result.blob,
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      width: result.width,
      height: result.height,
      thumb,
    };

    // Persist, but never lose the take if the quota rejects it —
    // the operator can still review and save it from memory.
    try {
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
      $('#reel-fill').style.width = '0%';
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
   * through the same crop the viewfinder's object-fit: cover is
   * already doing visually, before the constraint means anything.
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

    const vw = this.source.videoWidth;
    const vh = this.source.videoHeight;
    if (!vw || !vh) return;
    const [sx, sy, ox, oy] = coverCrop(vw, vh, FORMAT.ASPECT);
    const point = { x: ox + gx * sx, y: oy + gy * sy };

    const res = await this.camera.focusAt(point.x, point.y);
    // iOS Safari never exposes manual focus; the reticle above is
    // the only feedback there, on purpose — not a limitation worth
    // interrupting the operator to explain every time.
    if (!res.ok && res.reason === 'unsupported' && !this._focusWarned && !isIOS) {
      this._focusWarned = true;
      toast('This camera does not expose focus control to the browser.', 4000);
    }
  }

  /**
   * Exposure compensation, hardware where possible.
   *
   * On iOS Safari the sensor constraint does not exist, so the same
   * number is stored as a linear-light gain and applied before the
   * tone curve the next time a take is developed instead. It is not
   * identical — a real stop changes what the sensor collects — but
   * applied pre-curve it rolls off through the same shoulder rather
   * than clipping, which is far closer than a post-hoc brightness
   * slider. There is no live preview of it any more, the same way
   * there is no live preview of anything else in the grade.
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
   * through, rather than vanishing and leaving the operator
   * wondering where the flash went.
   */
  async toggleTorch() {
    const button = $('#btn-torch');
    const next = button.getAttribute('aria-pressed') !== 'true';

    const res = await this.camera.setTorch(next);
    if (!res.ok) {
      button.classList.add('is-unavailable');
      if (!isIOS) toast('This camera does not expose its flash to the browser.', 4200);
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

  /**
   * Zoom. 0.5× is a genuine lens switch (only where one exists); 1×
   * and 2× both live on the main lens, 2× via the hardware `zoom`
   * constraint where the browser exposes one, else a CSS scale for
   * live framing with the same factor baked into the actual crop
   * when the take is developed (see Developer.js / FilmRenderer).
   *
   * Locked during a take: a lens switch would swap the MediaStream
   * track out from under a live MediaRecorder, and there is no
   * frame-accurate way to vary the digital fallback's baked-in crop
   * partway through a single develop pass.
   */
  async setZoomLevel(level) {
    if (this.recorder?.isRecording) return;
    if (level === this.zoomLevel) return;

    if (level === 0.5) {
      const res = await this.camera.openUltrawide();
      if (!res.ok) return;
      this.source.srcObject = this.camera.stream;
      await this.source.play().catch(() => {});
      this.source.style.transform = '';
      this._digitalZoomFactor = 1;
      await this.configureCameraControls();
    } else {
      if (this.camera.lens !== 'main') {
        const res = await this.camera.openMain();
        if (res.ok) {
          this.source.srcObject = this.camera.stream;
          await this.source.play().catch(() => {});
          await this.configureCameraControls();
        }
      }
      if (level === 1) {
        if (this.camera.supports.zoom) await this.camera.setZoom(1);
        this.source.style.transform = '';
        this._digitalZoomFactor = 1;
      } else {
        const res = this.camera.supports.zoom ? await this.camera.setZoom(2) : { ok: false };
        if (res.ok) {
          this.source.style.transform = '';
          this._digitalZoomFactor = 1;
        } else {
          this.source.style.transform = 'scale(2)';
          this._digitalZoomFactor = 2;
        }
      }
    }

    this.zoomLevel = level;
    this.updateZoomUI();
    this.updateReadout();
    haptic('tick');
  }

  updateZoomUI() {
    for (const btn of $$('#zoom button')) {
      btn.setAttribute('aria-pressed', parseFloat(btn.dataset.zoom) === this.zoomLevel ? 'true' : 'false');
    }
  }

  /* =============================================================
     FULLSCREEN + WAKE LOCK
     ============================================================= */
  async enterFullscreen() {
    // Best-effort only, and called from the shutter rather than
    // from a control of its own. Limitation: iOS Safari on iPhone
    // implements no Fullscreen API for arbitrary elements — only
    // <video> — so this simply does nothing there. Installing the
    // PWA to the home screen is the supported way to get a
    // full-bleed, chrome-free camera on iOS, which is why the
    // manifest sets display: fullscreen.
    const target = document.documentElement;
    const request = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!request || document.fullscreenElement) return false;
    await request.call(target, { navigationUI: 'hide' });
    return true;
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
    if (note) note.textContent = err.message || 'This browser cannot run 70 mm.';
  }
});

// Offline support. Registered after load so it never competes with
// the camera for bandwidth or main-thread time on first run.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is optional */ });
  });

  // A new worker activating mid-session (see sw.js's skipWaiting +
  // clients.claim) otherwise leaves this tab quietly running the old
  // cached JS and images until the operator manually reloads — which
  // is exactly what made icon and film-strip fixes invisible without
  // a full reinstall. Reload once the new worker takes over, but
  // never mid-take: a recording or a develop pass in flight would be
  // destroyed by it, so an update landing then just waits its turn.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    const trySafeReload = () => {
      const busy = window.app?.recorder?.isRecording || window.app?.screen === 'processing';
      if (busy) { setTimeout(trySafeReload, 2000); return; }
      reloaded = true;
      location.reload();
    };
    trySafeReload();
  });
}
