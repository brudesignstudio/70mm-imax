/**
 * haptics.js
 * ---------------------------------------------------------------
 * Browser limitation, stated plainly:
 *
 *   iOS Safari does not implement navigator.vibrate(). There is no
 *   web API that reaches the Taptic Engine. The only thing that
 *   fires haptics on iOS from a web page is the native "switch"
 *   control's own feedback — which is a UI side-effect, not an API,
 *   and cannot be triggered programmatically at an arbitrary moment.
 *
 * So: on Android/Chrome we use the real Vibration API. On iOS we
 * fall back to a *visual* tally impulse (a one-frame flash of the
 * gate), which is what a camera operator actually needs the haptic
 * for — confirmation that the transport started or stopped.
 */

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

let enabled = true;
export function setHapticsEnabled(v) { enabled = !!v; }
export function hapticsSupported() { return canVibrate; }

/** Named patterns, in milliseconds. */
const PATTERNS = {
  start:   [18],
  stop:    [12, 60, 24],
  limit:   [24, 70, 24, 70, 40],   // magazine ran out
  tick:    [8],
  error:   [40, 50, 40],
};

export function haptic(kind = 'tick') {
  if (!enabled) return;
  const pattern = PATTERNS[kind] || PATTERNS.tick;
  if (canVibrate) {
    try { navigator.vibrate(pattern); } catch { /* ignore */ }
  } else {
    visualImpulse(kind);
  }
}

/**
 * iOS fallback: a very short luminance pulse on the gate border.
 * Deliberately subtle — it should register peripherally, the way a
 * viewfinder tally does, not read as a UI animation.
 */
function visualImpulse(kind) {
  const frame = document.getElementById('frame');
  if (!frame) return;
  const color = kind === 'error' ? 'rgba(255,107,94,.9)'
              : kind === 'stop'  ? 'rgba(244,236,224,.8)'
              : 'rgba(255,59,48,.9)';
  frame.animate(
    [
      { boxShadow: `0 0 0 1px ${color}, 0 24px 70px rgba(0,0,0,.9)` },
      { boxShadow: '0 0 0 1px rgba(255,238,214,.07), 0 24px 70px rgba(0,0,0,.9)' },
    ],
    { duration: kind === 'limit' ? 520 : 260, easing: 'cubic-bezier(.22,.61,.36,1)' }
  );
}
