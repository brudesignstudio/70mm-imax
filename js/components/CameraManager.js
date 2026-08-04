/**
 * CameraManager.js
 * ---------------------------------------------------------------
 * Owns the MediaStream: opening the right lens at the highest
 * resolution the browser will give us, and exposing whatever
 * manual control the platform actually implements.
 *
 * Platform reality, stated once so the rest of the app can ignore it:
 *
 *  • Lens choice — the web has no "main camera" API. facingMode
 *    'environment' picks *a* rear camera; on multi-lens phones
 *    Chrome exposes each lens as a separate device, so we
 *    enumerate and score labels to avoid landing on the ultra-wide
 *    or the telephoto. iOS Safari exposes one synthetic rear
 *    device, which is already the main lens.
 *
 *  • Focus / exposure / white balance — Chrome on Android
 *    implements the MediaTrack image-capture constraints on most
 *    devices. iOS Safari implements none of them. Where the
 *    hardware constraint is missing we fall back to the closest
 *    web-native equivalent (see below) rather than showing a
 *    control that silently does nothing.
 */

import { FORMAT } from '../config.js';
import { trackCapabilities, isIOS } from '../utils/capabilities.js';

/** Labels that indicate a lens we do *not* want as the default. */
const AVOID = /(ultra|wide angle|0\.5|telephoto|tele|zoom|depth|truedepth|infrared|ir\b)/i;
const PREFER = /(back|rear|environment|world)/i;

export class CameraManager {
  constructor() {
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.capabilities = {};
    this.settings = {};
    this.deviceId = null;
    this.devices = [];

    /** What this platform will actually let us drive. */
    this.supports = {
      focusPoint: false,
      focusMode: false,
      exposureMode: false,
      exposureCompensation: false,
      whiteBalanceMode: false,
      torch: false,
    };
  }

  /* =============================================================
     OPENING THE CAMERA
     ============================================================= */

  /**
   * @param {boolean} withAudio  include a microphone track
   * @returns {Promise<MediaStream>}
   */
  async open({ withAudio = true, deviceId = null } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not expose a camera to web pages.');
    }
    if (!window.isSecureContext) {
      throw new Error('Camera access requires HTTPS (or localhost).');
    }

    this.close();

    // Ask for the largest sensor read-out the UA will negotiate.
    // `ideal` rather than `exact` everywhere: an over-specified
    // constraint set is the most common cause of OverconstrainedError
    // on mid-range Android hardware.
    const video = {
      facingMode: { ideal: 'environment' },
      width:  { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: FORMAT.FPS, max: 60 },
      // Kill the UA's own beautification/stabilisation where offered;
      // we are doing our own grade and want the flattest source.
      resizeMode: 'none',
    };
    if (deviceId) video.deviceId = { exact: deviceId };

    const audio = withAudio ? {
      echoCancellation: false,   // we are recording a scene, not a call
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
    } : false;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (err) {
      // Two common recoveries, in order of likelihood.
      if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: withAudio,
        });
      } else if (err.name === 'NotAllowedError' && withAudio) {
        // The user may have granted camera but denied the mic.
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } else {
        throw this._friendly(err);
      }
    }

    this._adopt(stream);

    // Device labels are only readable *after* permission is granted,
    // so lens selection happens on the second pass.
    if (!deviceId) {
      const better = await this._findMainRearCamera();
      if (better && better !== this.settings.deviceId) {
        try { return await this.open({ withAudio, deviceId: better }); }
        catch { /* keep the stream we already have */ }
      }
    }

    return this.stream;
  }

  _adopt(stream) {
    this.stream = stream;
    this.videoTrack = stream.getVideoTracks()[0] || null;
    this.audioTrack = stream.getAudioTracks()[0] || null;

    if (this.videoTrack) {
      this.capabilities = trackCapabilities(this.videoTrack);
      this.settings = this.videoTrack.getSettings ? this.videoTrack.getSettings() : {};
      this.deviceId = this.settings.deviceId || null;

      const c = this.capabilities;
      this.supports.focusPoint = Array.isArray(c.focusMode) && c.focusMode.includes('manual') &&
                                 'pointsOfInterest' in c;
      this.supports.focusMode = Array.isArray(c.focusMode) && c.focusMode.length > 1;
      this.supports.exposureMode = Array.isArray(c.exposureMode) && c.exposureMode.length > 1;
      this.supports.exposureCompensation = !!c.exposureCompensation;
      this.supports.whiteBalanceMode = Array.isArray(c.whiteBalanceMode) && c.whiteBalanceMode.length > 1;
      this.supports.torch = !!c.torch;
    }
  }

  /** Score enumerated rear cameras and return the most "normal" one. */
  async _findMainRearCamera() {
    if (!navigator.mediaDevices.enumerateDevices) return null;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'videoinput');
    } catch { return null; }

    // iOS reports a single rear device which is already the main
    // lens; scoring its label buys nothing and can pick wrongly.
    if (isIOS || this.devices.length < 2) return null;

    const scored = this.devices
      .map((d) => {
        const label = d.label || '';
        let score = 0;
        if (PREFER.test(label)) score += 3;
        if (AVOID.test(label)) score -= 5;
        if (/camera2 0|back camera/i.test(label)) score += 2; // index 0 == main on Android
        return { id: d.deviceId, score, label };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.length ? scored[0].id : null;
  }

  _friendly(err) {
    const map = {
      NotAllowedError: 'Camera access was denied. Enable it for this site in your browser settings, then reload.',
      NotFoundError: 'No camera was found on this device.',
      NotReadableError: 'The camera is already in use by another app.',
      SecurityError: 'Camera access requires a secure (HTTPS) connection.',
      AbortError: 'The camera could not be started. Try reloading.',
    };
    const e = new Error(map[err.name] || `Camera error: ${err.message || err.name}`);
    e.name = err.name;
    return e;
  }

  /* =============================================================
     MANUAL CONTROL
     Each method returns { ok, reason } so the UI can say what
     happened rather than failing silently.
     ============================================================= */

  async _apply(constraints) {
    if (!this.videoTrack?.applyConstraints) return { ok: false, reason: 'unsupported' };
    try {
      await this.videoTrack.applyConstraints({ advanced: [constraints] });
      this.settings = this.videoTrack.getSettings();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.name || 'failed' };
    }
  }

  /**
   * Tap to focus. `x` and `y` are 0..1 within the *cropped gate*,
   * which the caller has already mapped back into sensor space.
   */
  async focusAt(x, y) {
    if (!this.supports.focusPoint) return { ok: false, reason: 'unsupported' };
    return this._apply({
      focusMode: 'single-shot',
      pointsOfInterest: [{ x, y }],
    });
  }

  /** Toggle auto-exposure lock. Returns the new locked state. */
  async setExposureLock(locked) {
    if (!this.supports.exposureMode) return { ok: false, reason: 'unsupported' };
    const modes = this.capabilities.exposureMode || [];
    const mode = locked
      ? (modes.includes('manual') ? 'manual' : modes.includes('single-shot') ? 'single-shot' : null)
      : (modes.includes('continuous') ? 'continuous' : null);
    if (!mode) return { ok: false, reason: 'unsupported' };
    return this._apply({ exposureMode: mode });
  }

  async setWhiteBalanceLock(locked) {
    if (!this.supports.whiteBalanceMode) return { ok: false, reason: 'unsupported' };
    const modes = this.capabilities.whiteBalanceMode || [];
    const mode = locked
      ? (modes.includes('manual') ? 'manual' : modes.includes('single-shot') ? 'single-shot' : null)
      : (modes.includes('continuous') ? 'continuous' : null);
    if (!mode) return { ok: false, reason: 'unsupported' };
    return this._apply({ whiteBalanceMode: mode });
  }

  /**
   * Exposure compensation in stops.
   *
   * Where the hardware constraint exists we drive the sensor, which
   * is always better — it changes the actual exposure rather than
   * pushing an already-quantised signal. Where it does not (iOS),
   * the caller applies the same number as a linear-light gain in
   * the shader instead. This method reports which path was taken so
   * the UI can label it.
   */
  async setExposureCompensation(stops) {
    if (!this.supports.exposureCompensation) return { ok: false, reason: 'unsupported', path: 'digital' };
    const cap = this.capabilities.exposureCompensation;
    // The constraint's units are device-defined; most report a
    // range in EV, some in 1/3-EV steps. Normalise via the range.
    const step = cap.step || 0.1;
    const value = Math.max(cap.min, Math.min(cap.max, Math.round(stops / step) * step));
    const res = await this._apply({ exposureCompensation: value });
    return { ...res, path: res.ok ? 'hardware' : 'digital' };
  }

  async setTorch(on) {
    if (!this.supports.torch) return { ok: false, reason: 'unsupported' };
    return this._apply({ torch: !!on });
  }

  /* =============================================================
     LIFECYCLE
     ============================================================= */

  /** Actual negotiated resolution, for the HUD. */
  get resolution() {
    const s = this.settings || {};
    return { width: s.width || 0, height: s.height || 0, frameRate: Math.round(s.frameRate || 0) };
  }

  close() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
  }
}
