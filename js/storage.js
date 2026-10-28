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
    audioPath: row.audio_path || row.audioPath || undefined,
    audioFile: row.audioFile || undefined,
    isPrivate: Boolean(row.is_private || row.isPrivate),
    createdAt: row.created_at || row.createdAt,
  };
}

const MESSAGE_COLUMNS = "id, type, name, text, font, duration, mime_type, audio_path, is_private, created_at";
const LEGACY_COLUMNS = "id, type, name, text, font, duration, mime_type, audio_path, created_at";

function isMissingPrivateSchema(error) {
  const detail = String((error && (error.message || error.details || error.hint)) || "").toLowerCase();
  return detail.includes("card_messages")
    || detail.includes("is_private")
    || detail.includes("schema cache")
    || detail.includes("could not find the table")
    || detail.includes("does not exist");
}

function privateSetupMessage(error, fallback) {
  const detail = String((error && (error.message || error.details || error.hint)) || "");
  if (/create_private_voice_message|unlock_voice_message|schema cache|could not find the function|does not exist/i.test(detail)) {
    return "Private voice notes are not enabled on the shared card yet. In the Supabase SQL Editor, run supabase/private-voice.sql.";
  }
  return apiMessage(error, fallback);
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
    const db = getClient();
    const fromView = await db
      .from("card_messages")
      .select(MESSAGE_COLUMNS)
      .order("created_at", { ascending: true });
    if (!fromView.error) return (fromView.data || []).map(rowToMessage);
    if (!isMissingPrivateSchema(fromView.error)) {
      throw new StorageError(apiMessage(fromView.error, "Could not load messages from the shared card."), fromView.error);
    }
    const fromTable = await db
      .from("messages")
      .select(LEGACY_COLUMNS)
      .order("created_at", { ascending: true });
    if (fromTable.error) {
      throw new StorageError(apiMessage(fromTable.error, "Could not load messages from the shared card."), fromTable.error);
    }
    return (fromTable.data || []).map(rowToMessage);
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

  async addVoice({ name, blob, duration, isPrivate = false, pin = "" }) {
    if (archivePayload()) {
      throw new StorageError("This offline archive cannot accept new messages.");
    }
    const trimmedName = String(name || "").trim();
    const trimmedPin = String(pin || "").trim();
    if (!trimmedName) throw new StorageError("Please enter your name before recording.");
    if (!blob || !blob.size) throw new StorageError("Record a message first, then add it to the card.");
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new StorageError("That recording is larger than 5 MB. Please record a shorter message.");
    }
    const seconds = Math.round(duration || 0);
    if (seconds < 1 || seconds > 180) {
      throw new StorageError("Voice messages must be between 1 second and 3 minutes.");
    }
    if (isPrivate && !/^\d{4}$/.test(trimmedPin)) {
      throw new StorageError("Enter a 4-digit PIN.");
    }

    const id = uid();
    const mimeType = blob.type || "audio/webm";
    const audioPath = `${isPrivate ? "private/" : ""}${id}.${extForMime(mimeType)}`;
    const db = getClient();

    const uploaded = await db.storage.from(BUCKET).upload(audioPath, blob, {
      contentType: mimeType,
      upsert: false,
    });
    if (uploaded.error) {
      throw new StorageError(apiMessage(uploaded.error, "The recording could not be uploaded."), uploaded.error);
    }

    if (isPrivate) {
      const saved = await db.rpc("create_private_voice_message", {
        message_id: id,
        sender_name: trimmedName,
        duration_seconds: seconds,
        mime_type: mimeType,
        audio_path: audioPath,
        pin: trimmedPin,
      });
      if (saved.error || !saved.data) {
        throw new StorageError(
          privateSetupMessage(
            saved.error,
            "The recording uploaded but was not added to the card. It is not a submitted message. In the Supabase dashboard, open Storage → voice-messages and delete any file that has no matching row in the messages table.",
          ),
          saved.error,
        );
      }
      return rowToMessage({
        id,
        type: "voice",
        name: trimmedName,
        duration: seconds,
        mime_type: mimeType,
        is_private: true,
        created_at: new Date().toISOString(),
      });
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
      .select(LEGACY_COLUMNS)
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

  async unlockVoice(messageId, pin) {
    if (archivePayload()) {
      throw new StorageError("This offline archive does not include that recording. Open the live card and enter the PIN.");
    }
    const provided = String(pin || "");
    if (!messageId || provided.trim().length < 4) {
      throw new StorageError("Incorrect PIN");
    }
    const { data, error } = await getClient().rpc("unlock_voice_message", {
      message_id: messageId,
      provided_pin: provided,
    });
    if (error) {
      const detail = String(error.message || "");
      if (/incorrect pin|invalid input syntax for type uuid|message not found/i.test(detail)) {
        throw new StorageError("Incorrect PIN", error);
      }
      throw new StorageError(privateSetupMessage(error, "This private message could not be unlocked."), error);
    }
    const path = data && (data.audio_path || data.audioPath);
    if (!data || data.ok === false || !path) {
      const reason = data && data.error ? String(data.error) : "Incorrect PIN";
      throw new StorageError(reason === "Incorrect PIN" ? "Incorrect PIN" : reason);
    }
    return path;
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

  async getSession() {
    if (archivePayload() || !readConfig()) return null;
    const { data } = await getClient().auth.getSession();
    return (data && data.session) || null;
  },

  onAuthChange(handler) {
    if (archivePayload() || !readConfig()) return { data: { subscription: { unsubscribe() {} } } };
    return getClient().auth.onAuthStateChange((_event, session) => handler(session));
  },

  async signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error || !data || !data.session) {
      throw new StorageError(apiMessage(error, "Sign-in failed. Check the email and password."), error);
    }
    return data.session;
  },

  async signOut() {
    if (archivePayload() || !readConfig()) return;
    await getClient().auth.signOut();
  },

  async remove(message) {
    if (archivePayload()) {
      throw new StorageError("This offline archive is read-only.");
    }
    if (!message || !message.id) {
      throw new StorageError("That message could not be deleted.");
    }
    const session = await CardStore.getSession();
    if (!session) {
      throw new StorageError("Please sign in as admin to delete a message.");
    }
    const supabase = getClient();
    const audio_path = message.audioPath;
    const messageId = message.id;
    if (message.type === "voice" && audio_path) {
      const buckets = [...new Set(["audio", BUCKET])];
      const failures = [];
      for (const bucket of buckets) {
        const { error } = await supabase.storage.from(bucket).remove([audio_path]);
        if (!error) continue;
        const detail = String(error.message || "").toLowerCase();
        if (detail.includes("not found") || detail.includes("does not exist")) continue;
        failures.push(error);
      }
      if (failures.length === buckets.length) {
        throw new StorageError(apiMessage(failures[0], "The voice file could not be deleted."), failures[0]);
      }
    }
    const { data, error } = await supabase.from("messages").delete().eq("id", messageId).select("id");
    if (error) {
      const detail = String(error.message || "").toLowerCase();
      if (detail.includes("permission denied")) {
        throw new StorageError(
          "The database refused the delete. In the Supabase SQL Editor, run supabase/fix-admin-delete.sql.",
          error,
        );
      }
      throw new StorageError(apiMessage(error, "The message could not be deleted."), error);
    }
    if (!data || !data.length) {
      const email = session.user && session.user.email ? session.user.email : "your Admin email";
      throw new StorageError(
        `The database kept this message. Signed in as ${email}. Run supabase/fix-admin-delete.sql, or lock the delete policy to that exact email.`,
      );
    }
  },

  async clear() {
    throw new StorageError("The website cannot wipe the card. Delete messages in the Supabase dashboard if you need to.");
  },
};

CardStore.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
CardStore.BUCKET = BUCKET;

LC.storage = { CardStore, StorageError, uid };
})(window.LeavingCard = window.LeavingCard || {});
