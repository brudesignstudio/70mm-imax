/**
 * format.js — display formatting for timers, sizes and dates.
 */

/** 93_400ms → "01:33" */
export function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 93_400ms → "1:33.4" — used on gallery cards where precision reads well. */
export function clockPrecise(ms) {
  const total = Math.max(0, ms / 1000);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function bytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Slate-style timestamp: "03 AUG 26 · 20:41" */
export function slate(ts) {
  const d = new Date(ts);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Filename for downloads: 70mm_20260803_2041.mp4 */
export function takeFilename(ts, ext) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `70mm_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/** Map a MIME type to a file extension. */
export function extFor(mime = '') {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  return 'bin';
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
