/**
 * storage.js
 * ---------------------------------------------------------------
 * Two kinds of persistence:
 *
 *  1. Preferences and look overrides → localStorage (small, sync).
 *  2. Recorded takes → IndexedDB (blobs, potentially hundreds of MB).
 *
 * Blobs are stored directly; every engine that supports IndexedDB
 * on mobile also supports structured-cloning a Blob into it, and
 * it avoids base64's 33% inflation.
 */

import { STORAGE } from '../config.js';

/* ---------------------------------------------------------------
   localStorage — never throws, even in private mode
   --------------------------------------------------------------- */
export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch { return { ...fallback }; }
}

export function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function clearKey(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------
   IndexedDB — the reel shelf
   --------------------------------------------------------------- */
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(STORAGE.DB_NAME, STORAGE.DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORAGE.DB_STORE)) {
        const store = db.createObjectStore(STORAGE.DB_STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORAGE.DB_STORE, mode);
    const store = t.objectStore(STORAGE.DB_STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/**
 * A take: { id, ts, blob, mime, durationMs, width, height, thumb (Blob) }
 */
export async function putTake(take) {
  await tx('readwrite', (store) => store.put(take));
  return take;
}

export async function getTake(id) {
  return tx('readonly', (store) => ({ __req: store.get(id) }));
}

export async function deleteTake(id) {
  return tx('readwrite', (store) => store.delete(id));
}

/** Newest first. */
export async function listTakes() {
  const all = await tx('readonly', (store) => ({ __req: store.getAll() }));
  return (all || []).sort((a, b) => b.ts - a.ts);
}

export async function countTakes() {
  try {
    const n = await tx('readonly', (store) => ({ __req: store.count() }));
    return n || 0;
  } catch { return 0; }
}

/** Rough free-space check so we can warn before a 3-minute take fails. */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
