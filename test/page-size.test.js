/**
 * Every page must stay A4 portrait (210 / 297) and fit the leftover viewport.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");
const context = { window: { LeavingCard: {} }, LeavingCard: {} };
context.window.LeavingCard = context.LeavingCard;
vm.runInNewContext(fs.readFileSync(path.join(root, "js/layout.js"), "utf8"), context);

const { computePageSize, A4_PORTRAIT_RATIO, layoutMessages, pickNoteWidth, contentMetrics, SMALL_PAGE_PADDING } =
  context.LeavingCard.layout;

const cases = [
  { name: "iPhone SE", w: 320 - 32 - 8, h: 320 - 20 },
  { name: "iPhone 13", w: 390 - 32 - 8, h: 520 - 20 },
  { name: "Pixel 7", w: 412 - 32 - 8, h: 580 - 20 },
  { name: "desktop", w: 1280 - 32 - 116, h: 620 - 24 },
];

let failed = 0;
for (const c of cases) {
  const size = computePageSize(c.w, c.h);
  const ratio = size.w / size.h;
  const ratioOk = Math.abs(ratio - A4_PORTRAIT_RATIO) < 0.01;
  const fits = size.w <= c.w + 0.5 && size.h <= c.h + 0.5;
  const portrait = size.h > size.w;
  const ok = ratioOk && fits && portrait;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.name}: ${size.w}x${size.h} ratio=${ratio.toFixed(4)} spread=${size.canSpread}`,
  );
  if (!ok) failed += 1;
}

const wide = computePageSize(1400, 700);
assert.ok(wide.canSpread, "a wide desktop stage should allow a two-page portrait spread");
assert.ok(wide.h > wide.w, "spread pages remain portrait");
console.log("PASS wide desktop can show two A4 portrait pages");

const voiceW = pickNoteWidth({ type: "voice" }, 140, () => 0.5);
assert.ok(voiceW <= 140, "voice tiles must not exceed the page content width");
assert.strictEqual(pickNoteWidth({ type: "voice" }, 500, () => 0.5), 168);
console.log("PASS voice note width is compact and clamped to the page");

const metrics = contentMetrics(400, 600);
assert.strictEqual(metrics.pad, SMALL_PAGE_PADDING);
const reserved = { x: 0, y: 0, w: metrics.areaW, h: 160 };
const laid = layoutMessages(
  [{ id: "note-1", type: "text", text: "Hello Tracey", name: "Sam" }],
  400,
  600,
  () => ({ w: 120, h: 40 }),
  { reserveFirstPage: reserved },
);
assert.ok(laid.length >= 1 && laid[0][0], "first message page still exists with a pinned video card");
const placed = laid[0][0];
assert.ok(placed.top >= metrics.pad + reserved.h, "notes sit below the centered video band");
console.log("PASS first message page reserves a centered top video band");

const emptyLayout = layoutMessages([], 400, 600, () => ({ w: 0, h: 0 }), {
  reserveFirstPage: reserved,
});
assert.strictEqual(emptyLayout.length, 1);
assert.ok(Array.isArray(emptyLayout[0]));
assert.strictEqual(emptyLayout[0].length, 0);
console.log("PASS empty card still keeps the first message page for the video");

const fiveNotes = Array.from({ length: 5 }, (_, i) => ({
  id: `note-${i}`,
  type: "text",
  text: "Thanks Tracey — good luck in the new job!",
  name: "Alex",
}));
const dense = layoutMessages(fiveNotes, 647, 915, () => ({ w: 150, h: 72 }));
assert.strictEqual(dense.length, 1, "five compact notes should share one A4 page");
assert.strictEqual(dense[0].length, 5);
console.log("PASS five compact notes fit on one A4 portrait page");

const belowVideo = layoutMessages(
  Array.from({ length: 3 }, (_, i) => ({
    id: `below-${i}`,
    type: "text",
    text: "A short note",
    name: "Sam",
  })),
  647,
  915,
  () => ({ w: 150, h: 72 }),
  { reserveFirstPage: { x: 0, y: 0, w: 647 - 40 * 2, h: 220 } },
);
assert.strictEqual(belowVideo[0].length, 3, "three notes should fit below the centered video");
console.log("PASS three notes fit below the centered video on page 2");

const app = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
assert.match(app, /Good Luck In Your New Job\./);
assert.match(app, /We Are All Going To/);
assert.match(app, /MISS YOU!!!/);
assert.match(app, /You have been such a great support to us all/);
assert.match(app, /Video\/Parrot-AI-20261019-Tracey\.mp4/);
assert.match(app, /A special address by the leader of the Free World, Donald R\. Trump \(POTUS\)/);
assert.match(app, /A farewell parody address for Tracey/);
assert.match(app, /pauseHiddenFeatureVideo/);
assert.match(app, /prepareMicrophone/);
assert.match(app, /Getting the microphone ready/);
assert.match(app, /flushPreroll/);
assert.match(app, /encodeWav/);
assert.match(app, /autoGainControl: false/);
assert.match(app, /trimSilence/);
assert.match(app, /peakNormalize/);
assert.match(app, /CardStore\.signIn/);
assert.match(app, /CardStore\.signOut/);
assert.match(app, /Delete this message from/);
assert.match(app, /state\.messages = await CardStore\.getAll\(\)/);
assert.match(fs.readFileSync(path.join(root, "js/storage.js"), "utf8"), /signInWithPassword/);
assert.match(fs.readFileSync(path.join(root, "js/storage.js"), "utf8"), /\["audio", BUCKET\]/);
assert.match(fs.readFileSync(path.join(root, "index.html"), "utf8"), /Admin Mode Active/);
assert.match(fs.readFileSync(path.join(root, "index.html"), "utf8"), /id="btn-admin"/);
assert.match(fs.readFileSync(path.join(root, "index.html"), "utf8"), /Make this message private \(for Tracey only\)/);
assert.match(fs.readFileSync(path.join(root, "index.html"), "utf8"), /Set a PIN so you or Tracey can unlock it/);
assert.match(fs.readFileSync(path.join(root, "index.html"), "utf8"), /Enter 4-digit PIN or Master Passcode to listen/);
assert.match(app, /Private message for Tracey — from/);
assert.match(app, /CardStore\.unlockVoice/);
assert.match(app, /Incorrect PIN/);
assert.match(fs.readFileSync(path.join(root, "js/storage.js"), "utf8"), /unlock_voice_message/);
assert.match(fs.readFileSync(path.join(root, "js/storage.js"), "utf8"), /create_private_voice_message/);
assert.doesNotMatch(fs.readFileSync(path.join(root, "js/storage.js"), "utf8"), /pin_hash/);
assert.match(app, /featureVideoCardWidth/);
assert.match(app, /\(areaW - cardW\) \/ 2/);
assert.doesNotMatch(app, /admin_reset_card/);
assert.doesNotMatch(app, /cleanup_orphan_audio/);
console.log("PASS cover, final wording, and pinned parody video, no public reset RPC calls");

const bookSrc = fs.readFileSync(path.join(root, "js/book.js"), "utf8");
assert.match(bookSrc, /\.feature-video/);
assert.match(bookSrc, /dialog\[open\]/);
console.log("PASS swipe ignores the video card and open dialogs");

const archiveSrc = fs.readFileSync(path.join(root, "js/archive.js"), "utf8");
assert.match(archiveSrc, /Video\/Parrot-AI-20261019-Tracey\.mp4/);
console.log("PASS archive includes the parody video file");

if (failed) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
console.log("All page-size cases passed");
