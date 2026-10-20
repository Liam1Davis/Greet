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
  console.log("PASS setup.sql has RLS and no public wipe/delete RPCs");

  const align = fs.readFileSync(path.join(root, "supabase/align-existing-messages.sql"), "utf8");
  assert.match(align, /NOT NULL DEFAULT 'Caveat'/);
  assert.match(align, /rename column font_name to font/);
  assert.match(align, /alter column font drop not null/i);
  assert.match(align, /alter column font drop default/i);
  console.log("PASS alignment strips font_name NOT NULL DEFAULT Caveat");

  const migration = fs.readFileSync(path.join(root, "supabase/migrate-remove-unsafe-rpcs.sql"), "utf8");
  assert.match(migration, /drop function if exists public\.cleanup_orphan_audio/);
  assert.match(migration, /drop function if exists public\.admin_reset_card/);
  assert.doesNotMatch(migration, /delete from public\.messages/i);
  console.log("PASS migration drops unsafe RPCs without deleting messages");

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
  assert.strictEqual(saved.type, "voice");
  console.log("PASS voice insert sends type, null text/font, duration, and audio_path");

  console.log("All storage/archive tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
