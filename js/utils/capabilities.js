/**
 * capabilities.js
 * ---------------------------------------------------------------
 * One honest place that answers "what can this browser actually do?"
 *
 * Every feature the app degrades on is probed here rather than
 * sniffed from the user agent, and the results are shown to the
 * user on the intro screen — if something will not work on their
 * phone, they find out before they try to shoot with it.
 */

export const isSecure = window.isSecureContext === true;

export const has = {
  getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  mediaRecorder: typeof window.MediaRecorder !== 'undefined',
  captureStream: !!(HTMLCanvasElement.prototype.captureStream ||
                    HTMLCanvasElement.prototype.mozCaptureStream),
  webgl: (() => {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch { return false; }
  })(),
  webgl2: (() => {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
  })(),
  shareFiles: !!(navigator.canShare && navigator.share),
  orientationLock: !!(screen.orientation && typeof screen.orientation.lock === 'function'),
  fullscreen: !!(document.documentElement.requestFullscreen ||
                 document.documentElement.webkitRequestFullscreen),
  vibrate: typeof navigator.vibrate === 'function',
  serviceWorker: 'serviceWorker' in navigator,
  wakeLock: 'wakeLock' in navigator,
  indexedDB: 'indexedDB' in window,
};

/** iOS reports itself in enough ways that this is worth centralising. */
export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isSafari =
  /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

/** The first MediaRecorder mime type from `candidates` this browser accepts. */
export function pickMimeType(candidates) {
  if (!has.mediaRecorder) return null;
  for (const type of candidates) {
    try { if (MediaRecorder.isTypeSupported(type)) return type; } catch { /* ignore */ }
  }
  return null; // let the browser choose its own default
}

/**
 * Which MediaTrackConstraints does this camera actually honour?
 * Chrome on Android exposes focus/exposure/white-balance modes on
 * most devices. iOS Safari exposes essentially none of them — see
 * CameraManager for what we do instead.
 */
export function trackCapabilities(track) {
  if (!track || typeof track.getCapabilities !== 'function') return {};
  try { return track.getCapabilities() || {}; } catch { return {}; }
}

/** Human-readable report for the intro screen. */
export function report(mime) {
  const rows = [
    ['Camera',        has.getUserMedia && isSecure, has.getUserMedia && !isSecure ? 'needs https' : null],
    ['GPU grade',     has.webgl,       has.webgl2 ? 'webgl 2' : 'webgl 1'],
    ['Recorder',      has.mediaRecorder && has.captureStream, mime ? mime.split(';')[0].replace('video/', '') : null],
    ['Save to Photos', has.shareFiles && (mime || '').includes('mp4'), has.shareFiles ? null : 'download only'],
    ['Orientation lock', has.orientationLock, has.orientationLock ? null : 'manual'],
    ['Haptics',       has.vibrate,     has.vibrate ? null : 'visual tally'],
    ['Offline',       has.serviceWorker],
  ];
  return rows.map(([label, ok, note]) => ({ label, ok, note }));
}
