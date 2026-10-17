/**
 * The six selectable handwriting-style fonts.
 * `className` maps to a CSS class in styles.css; `family` is the Google Fonts family
 * name (used for preloading via the CSS Font Loading API).
 *
 * Exposed on window.LeavingCard.fonts (classic scripts, so the card works from file://).
 */
(function (LC) {
"use strict";

const FONTS = [
  { id: "caveat", label: "Caveat", className: "font-caveat", family: "Caveat" },
  { id: "dancing", label: "Dancing Script", className: "font-dancing", family: "Dancing Script" },
  { id: "greatvibes", label: "Great Vibes", className: "font-greatvibes", family: "Great Vibes" },
  { id: "patrick", label: "Patrick Hand", className: "font-patrick", family: "Patrick Hand" },
  { id: "indie", label: "Indie Flower", className: "font-indie", family: "Indie Flower" },
  { id: "homemade", label: "Homemade Apple", className: "font-homemade", family: "Homemade Apple" },
];

const DEFAULT_FONT_ID = "caveat";

function getFont(id) {
  return FONTS.find((f) => f.id === id) || FONTS.find((f) => f.id === DEFAULT_FONT_ID);
}

/**
 * Ask the browser to load all handwriting fonts so that notes can be measured
 * accurately before layout. Resolves even if some fonts fail (we fall back to cursive).
 */
async function preloadFonts() {
  if (!("fonts" in document)) return;
  const loads = FONTS.map((f) => document.fonts.load(`italic 16px "${f.family}"`).catch(() => null));
  loads.push(document.fonts.load('italic 20px "Playfair Display"').catch(() => null));
  await Promise.all(loads);
  try {
    await document.fonts.ready;
  } catch {
    /* ignore */
  }
}

LC.fonts = { FONTS, DEFAULT_FONT_ID, getFont, preloadFonts };
})(window.LeavingCard = window.LeavingCard || {});
