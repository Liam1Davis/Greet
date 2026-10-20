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
const reserved = { x: metrics.areaW - 180, y: 0, w: 180, h: 160 };
const laid = layoutMessages(
  [{ id: "note-1", type: "text", text: "Hello Tracey", name: "Sam" }],
  400,
  600,
  () => ({ w: 120, h: 40 }),
  { reserveFirstPage: reserved },
);
assert.ok(laid.length >= 1 && laid[0][0], "first message page still exists with a pinned video card");
const placed = laid[0][0];
const videoBox = {
  x: metrics.pad + reserved.x,
  y: metrics.pad + reserved.y,
  w: reserved.w,
  h: reserved.h,
};
const overlapsVideo = !(
  placed.left + placed.width <= videoBox.x ||
  videoBox.x + videoBox.w <= placed.left ||
  placed.top + placed.height <= videoBox.y ||
  videoBox.y + videoBox.h <= placed.top
);
assert.ok(!overlapsVideo, "notes must not cover the top-right video card");
console.log("PASS first message page reserves the top-right video card");

const emptyLayout = layoutMessages([], 400, 600, () => ({ w: 0, h: 0 }), {
  reserveFirstPage: reserved,
});
assert.strictEqual(emptyLayout.length, 1);
assert.ok(Array.isArray(emptyLayout[0]));
assert.strictEqual(emptyLayout[0].length, 0);
console.log("PASS empty card still keeps the first message page for the video");

const fourNotes = Array.from({ length: 4 }, (_, i) => ({
  id: `note-${i}`,
  type: "text",
  text: "Thanks Tracey — good luck in the new job!",
  name: "Alex",
}));
const dense = layoutMessages(fourNotes, 647, 915, () => ({ w: 150, h: 72 }));
assert.strictEqual(dense.length, 1, "four compact notes should share one A4 page");
assert.strictEqual(dense[0].length, 4);
console.log("PASS four compact notes fit on one A4 portrait page");

const app = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
assert.match(app, /Good Luck In Your New Job\./);
assert.match(app, /We Are All Going To/);
assert.match(app, /MISS YOU!!!/);
assert.match(app, /You have been such a great support to us all/);
assert.match(app, /Video\/Parrot-AI-20261019-Tracey\.mp4/);
assert.match(app, /A special address by the leader of the Free World, Donald R\. Trump \(POTUS\)/);
assert.match(app, /A farewell parody address for Tracey/);
assert.match(app, /pauseHiddenFeatureVideo/);
assert.match(app, /featureVideoCardWidth/);
assert.match(app, /areaW - cardW/);
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
