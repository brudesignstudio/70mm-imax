/**
 * share.js — getting the file off the app and onto the device.
 *
 * There is no web API that writes directly to the iOS Photos
 * library. The closest thing, and the one native apps' share
 * sheets use too, is Web Share Level 2 (`navigator.share({files})`),
 * which on iOS presents the system sheet containing "Save Video".
 * That is the supported route and the app uses it first.
 *
 * Rules that actually matter in practice:
 *   • iOS will only offer "Save Video" for an MP4/MOV. A WebM is
 *     shown as a generic file and can only go to Files. A JPEG
 *     still gets "Save Image" on the same sheet, no special casing.
 *   • share() must be called from within a user gesture; awaiting
 *     anything slow before it (an IndexedDB read, a fetch) breaks
 *     the gesture on Safari. Callers therefore pass a Blob they
 *     already hold.
 *   • Chrome/Android supports the same API; where it does not, a
 *     plain <a download> is a real save into the Downloads folder.
 */

import { extFor, takeFilename } from './format.js';

/** Can this browser hand a file to the OS share sheet? */
export function canShareFile(blob) {
  if (!navigator.canShare || !navigator.share) return false;
  try {
    const file = new File([blob], 'probe.' + extFor(blob.type), { type: blob.type });
    return navigator.canShare({ files: [file] });
  } catch { return false; }
}

/**
 * Save a take — a video or a still, the routing is identical.
 * Returns { method, ok } where method is 'share' (system sheet →
 * Photos/Files) or 'download'. Must be called synchronously from a
 * user gesture.
 */
export async function saveMedia(blob, ts = Date.now()) {
  const ext = extFor(blob.type);
  const name = takeFilename(ts, ext);

  if (canShareFile(blob)) {
    const file = new File([blob], name, { type: blob.type });
    try {
      await navigator.share({ files: [file], title: name });
      return { ok: true, method: 'share' };
    } catch (err) {
      // AbortError means the user dismissed the sheet — not a
      // failure, and we must not then silently download behind them.
      if (err && err.name === 'AbortError') return { ok: false, method: 'share', cancelled: true };
      // Anything else: fall through to a download.
    }
  }

  return download(blob, name);
}

/** Plain download. On iOS Safari this lands in Files → Downloads. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the transfer before the
  // object URL is revoked; revoking immediately truncates it on
  // some WebKit builds.
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
  return { ok: true, method: 'download' };
}
