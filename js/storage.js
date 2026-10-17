/**
 * Storage adapter for the card.
 *
 * All methods are async and return plain objects, so this module can later be
 * swapped for a backend/API implementation (e.g. fetch('/api/messages')) without
 * touching the UI code. See README for the suggested interface.
 *
 * Current implementation:
 *   - Message metadata (name, text, font, timestamps) → localStorage (JSON)
 *   - Voice recordings → IndexedDB as Blobs (falls back to Base64 data URLs in
 *     localStorage if IndexedDB is unavailable)
 *
 * Message shape:
 *   {
 *     id: string,            // unique id
 *     type: 'text' | 'voice',
 *     name: string,          // contributor name
 *     text?: string,         // for text messages
 *     font?: string,         // font id (see fonts.js)
 *     duration?: number,     // seconds, for voice messages
 *     mimeType?: string,     // for voice messages
 *     audioData?: string,    // data URL fallback when IndexedDB is unavailable
 *     createdAt: string      // ISO timestamp
 *   }
 *
 * Exposed on window.LeavingCard.storage = { CardStore, StorageError, uid }.
 */
(function (LC) {
"use strict";

const LS_KEY = "tracey-leaving-card:messages:v1";
const DB_NAME = "tracey-leaving-card";
const DB_VERSION = 1;
const AUDIO_STORE = "audio";

class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "StorageError";
    this.cause = cause;
  }
}

/** Generate a reasonably unique id without external dependencies. */
function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------------ */
/* IndexedDB helpers                                                         */
/* ------------------------------------------------------------------------ */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  if (!("indexedDB" in globalThis)) {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          db.createObjectStore(AUDIO_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function idbRequest(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db) return reject(new StorageError("IndexedDB unavailable"));
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = fn(store);
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(new StorageError("IndexedDB transaction failed", tx.error));
        tx.onabort = () => reject(new StorageError("IndexedDB transaction aborted", tx.error));
      }),
  );
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new StorageError("Could not encode audio"));
    reader.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------------ */
/* localStorage helpers                                                      */
/* ------------------------------------------------------------------------ */

function readAll() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(messages) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(messages));
  } catch (err) {
    const quota =
      err && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED" || err.code === 22);
    throw new StorageError(
      quota
        ? "This device’s storage is full. Try deleting a voice message or using a shorter recording."
        : "Could not save to this device’s storage.",
      err,
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

const CardStore = {
  /** True when localStorage is usable. */
  isAvailable() {
    try {
      const k = "__probe__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  },

  /** @returns {Promise<Array>} all messages, oldest first */
  async getAll() {
    return readAll().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  },

  /**
   * Add a written message.
   * @param {{name:string, text:string, font:string}} data
   */
  async addText({ name, text, font }) {
    const message = {
      id: uid(),
      type: "text",
      name: name.trim(),
      text: text.trim(),
      font,
      createdAt: new Date().toISOString(),
    };
    const all = readAll();
    all.push(message);
    writeAll(all);
    return message;
  },

  /**
   * Add a voice message. Stores the Blob in IndexedDB where possible.
   * @param {{name:string, blob:Blob, duration:number}} data
   */
  async addVoice({ name, blob, duration }) {
    const id = uid();
    const message = {
      id,
      type: "voice",
      name: name.trim(),
      duration: Math.round(duration || 0),
      mimeType: blob.type || "audio/webm",
      createdAt: new Date().toISOString(),
    };

    let storedInIdb = false;
    try {
      await idbRequest(AUDIO_STORE, "readwrite", (store) => store.put(blob, id));
      storedInIdb = true;
    } catch {
      storedInIdb = false;
    }

    if (!storedInIdb) {
      // Fallback: inline as a data URL (subject to localStorage quota).
      message.audioData = await blobToDataUrl(blob);
    }

    const all = readAll();
    all.push(message);
    try {
      writeAll(all);
    } catch (err) {
      // Roll back the audio blob if metadata could not be saved.
      if (storedInIdb) {
        idbRequest(AUDIO_STORE, "readwrite", (store) => store.delete(id)).catch(() => {});
      }
      throw err;
    }
    return message;
  },

  /**
   * Resolve a playable URL for a voice message. Caller should revoke object URLs
   * when finished (handled in app.js).
   * @returns {Promise<string|null>}
   */
  async getAudioUrl(message) {
    if (message.audioData) return message.audioData;
    try {
      const blob = await idbRequest(AUDIO_STORE, "readonly", (store) => store.get(message.id));
      return blob ? URL.createObjectURL(blob) : null;
    } catch {
      return null;
    }
  },

  /** Remove a single message (and its audio, if any). */
  async remove(id) {
    const all = readAll().filter((m) => m.id !== id);
    writeAll(all);
    try {
      await idbRequest(AUDIO_STORE, "readwrite", (store) => store.delete(id));
    } catch {
      /* ignore */
    }
  },

  /** Remove everything. */
  async clear() {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
    try {
      await idbRequest(AUDIO_STORE, "readwrite", (store) => store.clear());
    } catch {
      /* ignore */
    }
  },
};

LC.storage = { CardStore, StorageError, uid };
})(window.LeavingCard = window.LeavingCard || {});
