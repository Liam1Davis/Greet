/**
 * Layout engine: scatters notes across pages without overlap.
 *
 * Each message is measured (via a caller-supplied `measure` function that renders
 * it offscreen) and then placed on the current page using seeded randomness, so the
 * layout looks natural but is stable across refreshes. When a note cannot fit on the
 * current page, a new page is started — this is what makes pagination dynamic.
 *
 * Exposed on window.LeavingCard.layout.
 */
(function (LC) {
"use strict";

/** Padding inside the page (keeps notes clear of the edge tap zones). */
const PAGE_PADDING = 52;
/** Padding used on small (phone-sized) pages; still wider than the 28px mobile edge zones. */
const SMALL_PAGE_PADDING = 32;
/** Minimum gap between note bounding boxes. */
const GAP = 12;
/** Reference content width (A4 landscape minus padding); widths scale down on smaller pages. */
const REFERENCE_AREA_W = 1123 - 2 * PAGE_PADDING;
/** Max rotation in degrees (notes are rotated between -ROT and +ROT). */
const ROT = 4;
/** Random placement attempts before falling back to a grid scan. */
const RANDOM_ATTEMPTS = 220;
/** How many valid random spots to compare before choosing one. */
const CANDIDATES = 24;
/** Jitter (px) applied when preferring top-left spots; keeps the scatter natural. */
const GRAVITY_JITTER = 110;
/** Grid scan step in px. */
const SCAN_STEP = 18;

/* Seeded PRNG (mulberry32) and a string hash so layouts are deterministic per message. */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Axis-aligned bounding box of a w×h rect rotated by `deg` degrees. */
function rotatedBounds(w, h, deg) {
  const r = (Math.abs(deg) * Math.PI) / 180;
  return {
    w: Math.ceil(w * Math.cos(r) + h * Math.sin(r)),
    h: Math.ceil(w * Math.sin(r) + h * Math.cos(r)),
  };
}

function overlaps(a, b) {
  return !(a.x + a.w + GAP <= b.x || b.x + b.w + GAP <= a.x || a.y + a.h + GAP <= b.y || b.y + b.h + GAP <= a.y);
}

/**
 * Pick a natural note width based on message length and the available area.
 */
function pickNoteWidth(message, areaW, rand) {
  if (message.type === "voice") return 230;
  const len = (message.text || "").length;
  let base;
  if (len < 50) base = 200;
  else if (len < 110) base = 260;
  else if (len < 200) base = 320;
  else base = 380;
  // small random variation so columns don't look uniform
  base += Math.round((rand() - 0.5) * 50);
  // On smaller pages, narrow the notes a little so more fit per page.
  const scale = Math.max(0.78, Math.min(1, areaW / REFERENCE_AREA_W));
  return Math.max(160, Math.min(Math.round(base * scale), areaW));
}

function tryPlace(placed, box, areaW, areaH, rand) {
  if (box.w > areaW || box.h > areaH) return null;
  const maxX = areaW - box.w;
  const maxY = areaH - box.h;

  // 1) Random attempts – gives the scattered, hand-placed look. Of the first few
  //    valid spots found, prefer higher ones (with jitter) so pages fill from the
  //    top and don't strand unusable gaps.
  let best = null;
  let found = 0;
  for (let i = 0; i < RANDOM_ATTEMPTS && found < CANDIDATES; i++) {
    const cand = { x: Math.round(rand() * maxX), y: Math.round(rand() * maxY), w: box.w, h: box.h };
    if (placed.some((p) => overlaps(cand, p))) continue;
    found++;
    // Prefer spots nearer the top-left (loose reading order) with jitter for variety.
    const score = cand.y + cand.x * 0.6 + rand() * GRAVITY_JITTER;
    if (!best || score < best.score) best = { ...cand, score };
  }
  if (best) return { x: best.x, y: best.y, w: best.w, h: best.h };

  // 2) Systematic scan – guarantees we use remaining space before starting a new page.
  //    Scan rows top→bottom with a slight random column offset to avoid rigid alignment.
  const colOffset = Math.round(rand() * SCAN_STEP);
  for (let y = 0; y <= maxY; y += SCAN_STEP) {
    for (let x = colOffset; x <= maxX; x += SCAN_STEP) {
      const cand = { x, y, w: box.w, h: box.h };
      if (!placed.some((p) => overlaps(cand, p))) return cand;
    }
  }
  return null;
}

/**
 * Lay out messages onto pages.
 *
 * @param {Array} messages           ordered list of messages
 * @param {number} pageW             page width in px
 * @param {number} pageH             page height in px
 * @param {(msg, width:number) => {w:number,h:number}} measure
 *        renders the message at `width` and returns its rendered size
 * @returns {Array<Array<PlacedNote>>} pages → placed notes
 *
 * PlacedNote: { message, left, top, width, height, rotation }
 *   left/top are the top-left of the *unrotated* note element, in page coordinates.
 */
function layoutMessages(messages, pageW, pageH, measure) {
  // Smaller pages (phones) get a tighter margin so more notes fit per page.
  const pad = pageW < 640 ? SMALL_PAGE_PADDING : PAGE_PADDING;
  const areaW = Math.max(100, pageW - pad * 2);
  const areaH = Math.max(100, pageH - pad * 2);

  const pages = [[]];
  let placedBoxes = [];

  for (const message of messages) {
    const rand = mulberry32(hashString(message.id || message.createdAt || Math.random().toString()));
    const width = pickNoteWidth(message, areaW, rand);
    const size = measure(message, width);
    const w = Math.ceil(size.w || width);
    const h = Math.ceil(size.h || 60);
    const rotation = Math.round((rand() * 2 - 1) * ROT * 10) / 10;
    const bb = rotatedBounds(w, h, rotation);

    let pos = tryPlace(placedBoxes, bb, areaW, areaH, rand);
    if (!pos) {
      // Start a fresh page.
      pages.push([]);
      placedBoxes = [];
      pos = tryPlace(placedBoxes, bb, areaW, areaH, rand) || { x: 0, y: 0, w: bb.w, h: bb.h };
    }
    placedBoxes.push(pos);

    // Convert bounding-box position to the note's unrotated top-left (centre aligned).
    const cx = pos.x + bb.w / 2;
    const cy = pos.y + bb.h / 2;
    pages[pages.length - 1].push({
      message,
      left: Math.round(pad + cx - w / 2),
      top: Math.round(pad + cy - h / 2),
      width: w,
      height: h,
      rotation,
    });
  }

  return pages;
}

LC.layout = { PAGE_PADDING, pickNoteWidth, layoutMessages };
})(window.LeavingCard = window.LeavingCard || {});
