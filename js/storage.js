/**
 * Shared card storage.
 *
 * Live site: Supabase Postgres + private Storage bucket.
 * Offline archive ZIP: window.LEAVING_CARD_ARCHIVE (embedded; read-only).
 *
 * There is no localStorage / IndexedDB fallback. A failed save is reported
 * as a failure.
 *
 * Exposed on window.LeavingCard.storage = { CardStore, StorageError, uid }.
 */
(function (LC) {
"use strict";

const BUCKET = "voice-messages";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const SIGNED_URL_SECONDS = 120;
const ALLOWED_FONTS = ["caveat", "dancing", "greatvibes", "patrick", "indie", "homemade"];

class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "StorageError";
    this.cause = cause;
  }
}

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function archivePayload() {
  return window.LEAVING_CARD_ARCHIVE && Array.isArray(window.LEAVING_CARD_ARCHIVE.messages)
    ? window.LEAVING_CARD_ARCHIVE
    : null;
}

function isPlaceholder(value, needle) {
  return !value || String(value).includes(needle);
}

function readConfig() {
  const cfg = window.LEAVING_CARD_SUPABASE || {};
  const url = String(cfg.url || "").trim();
  const anonKey = String(cfg.anonKey || "").trim();
  if (isPlaceholder(url, "YOUR-PROJECT") || isPlaceholder(anonKey, "YOUR-PUBLISHABLE")) {
    return null;
  }
  return { url, anonKey };
}

function isConfigured() {
  return Boolean(archivePayload() || readConfig());
}

let client = null;
function getClient() {
  if (archivePayload()) {
    throw new StorageError("This offline archive is read-only.");
  }
  const cfg = readConfig();
  if (!cfg) {
    throw new StorageError(
      "Supabase is not configured. Add the Project URL and anon public key to js/supabase-config.js.",
    );
  }
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    throw new StorageError("The Supabase library failed to load. Check your network connection and refresh.");
  }
  if (!client) client = window.supabase.createClient(cfg.url, cfg.anonKey);
  return client;
}

function apiMessage(error, fallback) {
  const detail = error && (error.message || error.error_description || error.details);
  return detail ? `${fallback} (${detail})` : fallback;
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    text: row.text || undefined,
    font: row.font || undefined,
    duration: row.duration == null ? undefined : Number(row.duration),
    mimeType: row.mime_type || undefined,
    audioPath: row.audio_path || undefined,
    audioFile: row.audioFile || undefined,
    createdAt: row.created_at || row.createdAt,
  };
}

function extForMime(mime) {
  const type = String(mime || "").toLowerCase();
  if (type.includes("mp4")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("wav")) return "wav";
  return "webm";
}

const CardStore = {
  isArchive() {
    return Boolean(archivePayload());
  },

  isConfigured,

  isAvailable() {
    return isConfigured();
  },

  async getAll() {
    const archive = archivePayload();
    if (archive) {
      return archive.messages.map(rowToMessage).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    }
    const { data, error } = await getClient()
      .from("messages")
      .select("id, type, name, text, font, duration, mime_type, audio_path, created_at")
      .order("created_at", { ascending: true });
    if (error) {
      throw new StorageError(apiMessage(error, "Could not load messages from the shared card."), error);
    }
    return (data || []).map(rowToMessage);
  },

  async addText({ name, text, font }) {
    if (archivePayload()) {
      throw new StorageError("This offline archive cannot accept new messages.");
    }
    const trimmedName = String(name || "").trim();
    const trimmedText = String(text || "").trim();
    if (!trimmedName || !trimmedText) {
      throw new StorageError("Name and message are required.");
    }
    if (!ALLOWED_FONTS.includes(font)) {
      throw new StorageError("Please choose one of the six handwriting styles.");
    }
    const { data, error } = await getClient()
      .from("messages")
      .insert({
        type: "text",
        name: trimmedName,
        text: trimmedText,
        font,
      })
      .select("id, type, name, text, font, duration, mime_type, audio_path, created_at")
      .single();
    if (error || !data) {
      throw new StorageError(apiMessage(error, "Your message was not saved to the shared card."), error);
    }
    return rowToMessage(data);
  },

  async addVoice({ name, blob, duration }) {
    if (archivePayload()) {
      throw new StorageError("This offline archive cannot accept new messages.");
    }
    const trimmedName = String(name || "").trim();
    if (!trimmedName) throw new StorageError("Please enter your name before recording.");
    if (!blob || !blob.size) throw new StorageError("Record a message first, then add it to the card.");
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new StorageError("That recording is larger than 5 MB. Please record a shorter message.");
    }
    const seconds = Math.round(duration || 0);
    if (seconds < 1 || seconds > 180) {
      throw new StorageError("Voice messages must be between 1 second and 3 minutes.");
    }

    const id = uid();
    const mimeType = blob.type || "audio/webm";
    const audioPath = `${id}.${extForMime(mimeType)}`;
    const db = getClient();

    const uploaded = await db.storage.from(BUCKET).upload(audioPath, blob, {
      contentType: mimeType,
      upsert: false,
    });
    if (uploaded.error) {
      throw new StorageError(apiMessage(uploaded.error, "The recording could not be uploaded."), uploaded.error);
    }

    const inserted = await db
      .from("messages")
      .insert({
        id,
        type: "voice",
        name: trimmedName,
        text: null,
        font: null,
        duration: seconds,
        mime_type: mimeType,
        audio_path: audioPath,
      })
      .select("id, type, name, text, font, duration, mime_type, audio_path, created_at")
      .single();

    if (inserted.error || !inserted.data) {
      throw new StorageError(
        apiMessage(
          inserted.error,
          "The recording uploaded but was not added to the card. It is not a submitted message. In the Supabase dashboard, open Storage → voice-messages and delete any file that has no matching row in the messages table.",
        ),
        inserted.error,
      );
    }
    return rowToMessage(inserted.data);
  },

  async getAudioUrl(message) {
    if (!message) return null;
    const archive = archivePayload();
    if (archive) {
      return message.audioFile || (message.audioPath ? `audio/${message.audioPath}` : null);
    }
    if (!message.audioPath) return null;
    const { data, error } = await getClient().storage.from(BUCKET).createSignedUrl(message.audioPath, SIGNED_URL_SECONDS);
    if (error || !data || !data.signedUrl) {
      throw new StorageError(apiMessage(error, "This voice message could not be played."), error);
    }
    return data.signedUrl;
  },

  async getAudioBlob(message) {
    if (!message || !message.audioPath) return null;
    const { data, error } = await getClient().storage.from(BUCKET).download(message.audioPath);
    if (error || !data) {
      throw new StorageError(apiMessage(error, "Could not download a voice recording for the archive."), error);
    }
    return data;
  },

  async remove() {
    throw new StorageError("Individual messages cannot be deleted from the website.");
  },

  async clear() {
    throw new StorageError("The website cannot wipe the card. Delete messages in the Supabase dashboard if you need to.");
  },
};

CardStore.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
CardStore.BUCKET = BUCKET;

LC.storage = { CardStore, StorageError, uid };
})(window.LeavingCard = window.LeavingCard || {});
