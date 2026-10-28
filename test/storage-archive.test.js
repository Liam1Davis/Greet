/**
 * Success tests that do not need a live Supabase project:
 *  - ZIP builder is a valid store-method archive
 *  - archive mode is read-only and does not use localStorage
 *  - unconfigured live mode refuses to save
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");

function loadScript(file, context) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}

function makeWindow() {
  const window = {
    LEAVING_CARD_SUPABASE: { url: "https://YOUR-PROJECT.supabase.co", anonKey: "YOUR-PUBLISHABLE-ANON-KEY" },
  };
  window.window = window;
  window.LeavingCard = {};
  return {
    window,
    LeavingCard: window.LeavingCard,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    DataView,
  };
}

async function run() {
  const zipWindow = makeWindow();
  loadScript("js/archive.js", zipWindow);
  const payload = new TextEncoder().encode("hello archive");
  const zip = zipWindow.LeavingCard.archive.buildZip([{ name: "readme.txt", data: payload }]);
  assert.ok(zip.length > 30, "zip should contain headers");
  const sig = String.fromCharCode(zip[0], zip[1], zip[2], zip[3]);
  assert.strictEqual(sig, "PK\u0003\u0004", "zip local file header");
  console.log("PASS zip builder");

  const html = `<script defer src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
  <script defer src="js/supabase-config.js"></script>`;
  const rewritten = zipWindow.LeavingCard.archive.buildArchiveIndexHtml(html, false);
  assert.doesNotMatch(rewritten, /supabase-js/);
  assert.match(rewritten, /js\/archive-data\.js/);
  assert.doesNotMatch(rewritten, /js\/supabase-config\.js/);
  console.log("PASS archive HTML is offline and does not load Supabase");

  const archiveSrc = fs.readFileSync(path.join(root, "js/archive.js"), "utf8");
  assert.match(archiveSrc, /Video\/Parrot-AI-20261019-Tracey\.mp4/);
  console.log("PASS archive export includes the parody video");

  const live = makeWindow();
  loadScript("js/storage.js", live);
  const store = live.LeavingCard.storage.CardStore;
  assert.strictEqual(store.isConfigured(), false, "placeholders must not count as configured");
  let failed = false;
  try {
    await store.addText({ name: "Sam", text: "Hello", font: "caveat" });
  } catch (err) {
    failed = /Supabase is not configured/.test(err.message);
  }
  assert.ok(failed, "unconfigured save must throw");
  assert.strictEqual(global.localStorage, undefined);
  console.log("PASS unconfigured live mode refuses save");

  const archive = makeWindow();
  archive.window.LEAVING_CARD_ARCHIVE = {
    generatedAt: "2026-10-18T00:00:00.000Z",
    messages: [
      {
        id: "1",
        type: "text",
        name: "Sam",
        text: "Good luck",
        font: "caveat",
        createdAt: "2026-10-18T00:00:00.000Z",
      },
    ],
  };
  loadScript("js/storage.js", archive);
  const archived = archive.window.LeavingCard.storage.CardStore;
  const rows = await archived.getAll();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, "Sam");
  let writeBlocked = false;
  try {
    await archived.addText({ name: "Jo", text: "Hi", font: "caveat" });
  } catch (err) {
    writeBlocked = /read-only|cannot accept/.test(err.message);
  }
  assert.ok(writeBlocked, "archive must reject new messages");
  console.log("PASS archive mode is read-only and loads embedded messages");

  const sql = fs.readFileSync(path.join(root, "supabase/setup.sql"), "utf8");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /anyone can read messages/);
  assert.match(sql, /anyone can add a message/);
  assert.match(sql, /voice-messages/);
  assert.match(sql, /rename column audio_key to audio_path/);
  assert.match(sql, /rename column font_name to font/);
  assert.match(sql, /NOT NULL DEFAULT 'Caveat'/);
  assert.match(sql, /alter column font drop not null/i);
  assert.match(sql, /alter column font drop default/i);
  assert.match(sql, /alter column font_name drop not null/i);
  assert.match(sql, /alter column font_name drop default/i);
  assert.doesNotMatch(sql, /add column if not exists audio_key/);
  assert.doesNotMatch(sql, /font text not null/i);
  assert.doesNotMatch(sql, /default 'Caveat'::text/i);
  assert.doesNotMatch(sql, /create or replace function public\.cleanup_orphan_audio/);
  assert.doesNotMatch(sql, /create or replace function public\.admin_reset_card/);
  assert.doesNotMatch(sql, /service_role/);
  assert.match(sql, /authenticated can delete messages/);
  assert.match(sql, /authenticated can delete voice messages/);
  assert.match(sql, /grant delete on table public.messages to authenticated/);
  assert.match(sql, /revoke delete on table public.messages from anon/);
  console.log("PASS setup.sql has RLS, authenticated admin delete, and no public wipe RPCs");

  const adminSql = fs.readFileSync(path.join(root, "supabase/enable-admin-delete.sql"), "utf8");
  assert.match(adminSql, /authenticated can delete messages/);
  assert.match(adminSql, /voice-messages/);
  assert.doesNotMatch(adminSql, /delete from public\.messages/i);
  console.log("PASS enable-admin-delete.sql grants authenticated delete without wiping rows");

  const align = fs.readFileSync(path.join(root, "supabase/align-existing-messages.sql"), "utf8");
  assert.match(align, /NOT NULL DEFAULT 'Caveat'/);
  assert.match(align, /rename column font_name to font/);
  assert.match(align, /alter column font drop not null/i);
  assert.match(align, /alter column font drop default/i);
  console.log("PASS alignment strips font_name NOT NULL DEFAULT Caveat");

  const migration = fs.readFileSync(path.join(root, "supabase/migrate-remove-unsafe-rpcs.sql"), "utf8");
  assert.match(migration, /drop function if exists public\.cleanup_orphan_audio/);
  assert.match(migration, /drop function if exists public\.admin_reset_card/);
  assert.match(migration, /grant delete on table public.messages to authenticated/);
  assert.doesNotMatch(migration, /delete from public\.messages/i);
  console.log("PASS migration drops unsafe RPCs without deleting messages");

  const restoreGrant = fs.readFileSync(path.join(root, "supabase/restore-admin-delete-grant.sql"), "utf8");
  assert.match(restoreGrant, /grant delete on table public.messages to authenticated/);
  assert.doesNotMatch(restoreGrant, /delete from public\.messages/i);
  assert.doesNotMatch(restoreGrant, /drop policy/i);
  console.log("PASS restore-admin-delete-grant.sql restores GRANT DELETE without changing policies");

  const fixDelete = fs.readFileSync(path.join(root, "supabase/fix-admin-delete.sql"), "utf8");
  assert.match(fixDelete, /grant delete on table public.messages to authenticated/);
  assert.match(fixDelete, /authenticated can delete messages/);
  assert.match(fixDelete, /auth\.role\(\) = 'authenticated'/);
  assert.doesNotMatch(fixDelete, /delete from public\.messages/i);
  console.log("PASS fix-admin-delete.sql restores authenticated delete without wiping rows");

  const privateSql = fs.readFileSync(path.join(root, "supabase/private-voice.sql"), "utf8");
  assert.match(privateSql, /function public\.unlock_voice_message/);
  assert.match(privateSql, /function public\.create_private_voice_message/);
  assert.match(privateSql, /crypt\(/);
  assert.match(privateSql, /message_pins/);
  assert.match(privateSql, /is_private/);
  assert.match(privateSql, /voice_playback_grants/);
  assert.match(privateSql, /name not like 'private\/%'/);
  assert.match(privateSql, /Incorrect PIN/);
  assert.match(privateSql, /revoke all on public\.message_pins/i);
  assert.doesNotMatch(privateSql, /service_role/);
  assert.match(sql, /function public\.unlock_voice_message/);
  assert.match(sql, /drop policy if exists "anon can read voice messages"/);
  console.log("PASS private voice SQL hashes the PIN and blocks anonymous reads of private/");

  let wipeBlocked = false;
  try {
    await store.clear();
  } catch (err) {
    wipeBlocked = /cannot wipe|dashboard/i.test(err.message);
  }
  assert.ok(wipeBlocked, "website cannot wipe the card");
  console.log("PASS CardStore.clear refuses to wipe the card");

  const voiceInserts = [];
  const configured = makeWindow();
  configured.window.LEAVING_CARD_SUPABASE = {
    url: "https://example.supabase.co",
    anonKey: "test-publishable-anon-key",
  };
  configured.window.supabase = {
    createClient() {
      return {
        storage: {
          from() {
            return {
              upload: async () => ({ error: null }),
            };
          },
        },
        from() {
          return {
            insert(row) {
              voiceInserts.push(row);
              return {
                select() {
                  return {
                    async single() {
                      return {
                        data: {
                          id: row.id,
                          type: row.type,
                          name: row.name,
                          text: row.text,
                          font: row.font,
                          duration: row.duration,
                          mime_type: row.mime_type,
                          audio_path: row.audio_path,
                          created_at: "2026-10-19T00:00:00.000Z",
                        },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  loadScript("js/storage.js", configured);
  const configuredStore = configured.window.LeavingCard.storage.CardStore;
  const blob = new Blob([new Uint8Array(32)], { type: "audio/webm" });
  const saved = await configuredStore.addVoice({ name: "Sam", blob, duration: 12 });
  const voiceRow = voiceInserts[0];
  assert.ok(voiceRow, "voice insert should be sent");
  assert.strictEqual(voiceRow.type, "voice");
  assert.strictEqual(voiceRow.text, null);
  assert.strictEqual(voiceRow.font, null);
  assert.strictEqual(voiceRow.duration, 12);
  assert.ok(voiceRow.audio_path && !String(voiceRow.audio_path).startsWith("http"));
  assert.ok(!String(voiceRow.audio_path).startsWith("private/"));
  assert.strictEqual(voiceRow.pin, undefined);
  assert.strictEqual(voiceRow.is_private, undefined);
  assert.strictEqual(saved.type, "voice");
  assert.strictEqual(saved.isPrivate, false);
  console.log("PASS voice insert sends type, null text/font, duration, and audio_path");

  const privateUploads = [];
  const privateRpc = [];
  const privateWin = makeWindow();
  privateWin.window.LEAVING_CARD_SUPABASE = {
    url: "https://example.supabase.co",
    anonKey: "test-publishable-anon-key",
  };
  privateWin.window.supabase = {
    createClient() {
      return {
        storage: {
          from() {
            return {
              upload: async (path) => {
                privateUploads.push(path);
                return { error: null };
              },
            };
          },
        },
        rpc: async (fn, args) => {
          privateRpc.push({ fn, args });
          return { data: args.message_id, error: null };
        },
        from() {
          return {
            insert() {
              throw new Error("private voice must not insert pin_hash from the browser");
            },
          };
        },
      };
    },
  };
  loadScript("js/storage.js", privateWin);
  const privateStore = privateWin.window.LeavingCard.storage.CardStore;
  const privateBlob = new Blob([new Uint8Array(16)], { type: "audio/webm" });
  let pinRejected = false;
  try {
    await privateStore.addVoice({ name: "Sam", blob: privateBlob, duration: 4, isPrivate: true, pin: "12" });
  } catch (err) {
    pinRejected = /4-digit PIN/.test(err.message);
  }
  assert.ok(pinRejected, "a private voice note requires a 4-digit PIN before upload");
  assert.strictEqual(privateUploads.length, 0);
  const privateSaved = await privateStore.addVoice({
    name: "Sam",
    blob: privateBlob,
    duration: 4,
    isPrivate: true,
    pin: "2468",
  });
  assert.strictEqual(privateRpc.length, 1);
  assert.strictEqual(privateRpc[0].fn, "create_private_voice_message");
  assert.strictEqual(privateRpc[0].args.pin, "2468");
  assert.strictEqual(privateRpc[0].args.sender_name, "Sam");
  assert.ok(String(privateRpc[0].args.audio_path).startsWith("private/"));
  assert.strictEqual(privateUploads[0], privateRpc[0].args.audio_path);
  assert.strictEqual(privateRpc[0].args.pin_hash, undefined);
  assert.strictEqual(privateSaved.isPrivate, true);
  assert.strictEqual(privateSaved.audioPath, undefined);
  console.log("PASS private voice upload uses a private path and the server hashes the PIN");

  const unlockWin = makeWindow();
  unlockWin.window.LEAVING_CARD_SUPABASE = {
    url: "https://example.supabase.co",
    anonKey: "test-publishable-anon-key",
  };
  unlockWin.window.supabase = {
    createClient() {
      return {
        rpc: async (fn, args) => {
          assert.strictEqual(fn, "unlock_voice_message");
          assert.strictEqual(args.message_id, "msg-9");
          if (args.provided_pin === "0000") return { data: { ok: false, error: "Incorrect PIN" }, error: null };
          if (args.provided_pin === "bad!") {
            return { data: null, error: { message: 'invalid input syntax for type uuid: "nope"' } };
          }
          if (args.provided_pin === "gone") {
            return { data: null, error: { message: "Message not found" } };
          }
          if (args.provided_pin === "9999") {
            return { data: { ok: false, error: "Too many attempts. Wait a few minutes and try again." }, error: null };
          }
          return { data: { ok: true, audio_path: "private/msg.webm" }, error: null };
        },
      };
    },
  };
  loadScript("js/storage.js", unlockWin);
  const unlockStore = unlockWin.window.LeavingCard.storage.CardStore;
  let wrongPin = false;
  try {
    await unlockStore.unlockVoice("msg-9", "0000");
  } catch (err) {
    wrongPin = err.message === "Incorrect PIN";
  }
  assert.ok(wrongPin, "wrong PIN is reported as Incorrect PIN");
  let badId = false;
  try {
    await unlockStore.unlockVoice("msg-9", "bad!");
  } catch (err) {
    badId = err.message === "Incorrect PIN";
  }
  assert.ok(badId, "a database uuid error is shown as Incorrect PIN");
  let missing = false;
  try {
    await unlockStore.unlockVoice("msg-9", "gone");
  } catch (err) {
    missing = err.message === "Incorrect PIN";
  }
  assert.ok(missing, "a missing message is shown as Incorrect PIN");
  let lockedOut = false;
  try {
    await unlockStore.unlockVoice("msg-9", "9999");
  } catch (err) {
    lockedOut = /Too many attempts/.test(err.message);
  }
  assert.ok(lockedOut, "too many PIN attempts are surfaced");
  const unlockedPath = await unlockStore.unlockVoice("msg-9", "2468");
  assert.strictEqual(unlockedPath, "private/msg.webm");
  console.log("PASS unlock_voice_message accepts the PIN and rejects a wrong one");

  let removeBlocked = false;
  try {
    await store.remove({ id: "x", type: "text", name: "Sam" });
  } catch (err) {
    removeBlocked = /admin|not configured|cannot/i.test(err.message);
  }
  assert.ok(removeBlocked, "unconfigured live mode cannot delete messages");
  console.log("PASS unconfigured remove is blocked");

  const deleted = { storage: [], rows: [] };
  const adminWin = makeWindow();
  adminWin.window.LEAVING_CARD_SUPABASE = {
    url: "https://example.supabase.co",
    anonKey: "test-publishable-anon-key",
  };
  adminWin.window.supabase = {
    createClient() {
      return {
        auth: {
          async getSession() {
            return { data: { session: { user: { id: "admin-1" } } }, error: null };
          },
          async signInWithPassword({ email, password }) {
            assert.strictEqual(email, "a@b.c");
            assert.strictEqual(password, "secret");
            return { data: { session: { user: { id: "admin-1" } } }, error: null };
          },
        },
        storage: {
          from(bucket) {
            return {
              remove: async (paths) => {
                deleted.storage.push({ bucket, paths });
                return { error: null };
              },
            };
          },
        },
        from(table) {
          assert.strictEqual(table, "messages");
          return {
            delete() {
              return {
                eq(col, id) {
                  assert.strictEqual(col, "id");
                  deleted.rows.push(id);
                  return {
                    select() {
                      return Promise.resolve({ data: [{ id }], error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  loadScript("js/storage.js", adminWin);
  const adminStore = adminWin.window.LeavingCard.storage.CardStore;
  const session = await adminStore.signIn("a@b.c", "secret");
  assert.ok(session && session.user.id === "admin-1");
  await adminStore.remove({
    id: "msg-1",
    type: "voice",
    name: "Sam",
    audioPath: "sam/voice.webm",
  });
  assert.ok(deleted.storage[0]);
  assert.strictEqual(String(deleted.storage[0].bucket), "audio");
  assert.strictEqual(String(deleted.storage[0].paths[0]), "sam/voice.webm");
  assert.ok(deleted.storage.some((entry) => String(entry.bucket) === "voice-messages"));
  assert.strictEqual(deleted.rows.length, 1);
  assert.strictEqual(deleted.rows[0], "msg-1");
  console.log("PASS admin remove deletes the voice object then the message row");

  console.log("All storage/archive tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
