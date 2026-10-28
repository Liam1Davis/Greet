/**
 * Tracey’s Leaving Card — main application.
 *
 * Responsibilities:
 *   - size the A4 card to the viewport
 *   - render cover / message pages / final page
 *   - manage the "add message" and "record voice" dialogs
 *   - persist via CardStore (see storage.js)
 *
 * Classic (non-module) scripts are used so the card also works when index.html is
 * opened directly from disk. Dependencies are read from window.LeavingCard.
 */
(function (LC) {
"use strict";

const { CardStore, StorageError } = LC.storage;
const { FONTS, DEFAULT_FONT_ID, getFont, preloadFonts } = LC.fonts;
const { CATEGORIES, searchLibrary } = LC.library;
const { layoutMessages, computePageSize, contentMetrics } = LC.layout;
const { Book } = LC;

/* ------------------------------------------------------------------------ */
/* Constants & state                                                         */
/* ------------------------------------------------------------------------ */

const MAX_RECORD_SECONDS = 180;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CONTRIBUTE_INDEX = 1;

/** Tracey's photo. If this file is missing the placeholder is shown instead. */
const COVER_PHOTO_SRC = "assets/tracey.jpg";
const COVER_PHOTO_FALLBACK = "assets/tracey-placeholder.svg";
const FEATURE_VIDEO_SRC = "Video/Parrot-AI-20261019-Tracey.mp4";
const FEATURE_VIDEO_TITLE = "A special address by the leader of the Free World, Donald R. Trump (POTUS)";
const FEATURE_VIDEO_SUBTITLE = "A farewell parody address for Tracey";

const COVER_HEADING = "Good Luck In Your New Job. We Are All Going To MISS YOU!!!";
const FINAL_MESSAGE =
  "You have been such a great support to us all — always calm, collected and positive. We’re all going to miss you dearly. Thank you for everything.";

const state = {
  messages: [],
  pageSize: { w: 0, h: 0 },
  pageMap: new Map(), // message id → page index (for jumping to a new note)
  persistent: true,
  featureVideoRatio: { w: 1, h: 1 },
  adminSession: null,
};

/* ------------------------------------------------------------------------ */
/* DOM helpers                                                               */
/* ------------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* Toasts */
const toastRegion = $("#toast-region");
function toast(message, { type = "info", duration = 4200 } = {}) {
  const node = el("div", { class: `toast${type === "error" ? " toast--error" : ""}`, role: "status", text: message });
  toastRegion.append(node);
  setTimeout(() => {
    node.classList.add("is-leaving");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  }, duration);
}

/* Decorative SVG snippets (original, simple line art) */
const FLOURISH_SVG = `
<svg viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#a98a44" stroke-width="1.4" stroke-linecap="round">
  <path d="M6 110 C 30 60, 70 40, 120 46 C 150 50, 170 40, 194 18" />
  <path d="M6 110 C 20 80, 50 70, 80 80" />
  <path d="M60 58 c -6 -14, 6 -22, 14 -12 c 8 -10, 20 -2, 14 12 c -8 8, -20 8, -28 0z" fill="#d9a7a0" stroke="#c48b84"/>
  <path d="M118 44 c -4 -10, 6 -16, 11 -8 c 6 -8, 15 -2, 10 8 c -6 6, -15 6, -21 0z" fill="#9fb8a4" stroke="#7e9b84"/>
  <path d="M40 90 q 10 -14, 24 -6 q -12 10, -24 6z" fill="#9fb8a4" stroke="#7e9b84"/>
  <path d="M150 42 q 12 -10, 22 -2 q -12 8, -22 2z" fill="#9fb8a4" stroke="#7e9b84"/>
  <circle cx="90" cy="70" r="2.2" fill="#c9a961" stroke="none"/>
  <circle cx="170" cy="30" r="1.8" fill="#c9a961" stroke="none"/>
  <circle cx="30" cy="100" r="1.8" fill="#c9a961" stroke="none"/>
</svg>`;

const CORNER_SVG = `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#a98a44" stroke-width="1.2" stroke-linecap="round">
  <path d="M4 116 C 20 70, 50 40, 116 6" />
  <path d="M4 116 C 30 96, 60 90, 90 94" />
  <path d="M46 62 q 10 -12, 22 -4 q -12 10, -22 4z" fill="#9fb8a4" stroke="#7e9b84"/>
  <path d="M78 40 c -4 -9, 5 -14, 10 -7 c 5 -7, 14 -2, 9 7 c -5 5, -14 5, -19 0z" fill="#d9a7a0" stroke="#c48b84"/>
  <circle cx="30" cy="92" r="1.6" fill="#c9a961" stroke="none"/>
</svg>`;

/* ------------------------------------------------------------------------ */
/* Card sizing                                                               */
/* ------------------------------------------------------------------------ */

const stageEl = $("#stage");
const bookEl = $("#book");
const bookWrapEl = $(".book-wrap");

function measureStage() {
  const stageRect = stageEl.getBoundingClientRect();
  const styles = getComputedStyle(stageEl);
  const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);

  const navVisible = getComputedStyle($("#btn-prev")).display !== "none";
  const navAllowance = navVisible ? 2 * (46 + 12) : 0;
  const gutter = window.innerWidth <= 760 ? 8 : 0;
  let availW = stageRect.width - padX - navAllowance - gutter;
  let availH = stageRect.height - padY;

  if (!Number.isFinite(availW) || availW < 120) {
    availW = Math.max(120, window.innerWidth - padX - navAllowance - 24);
  }
  if (!Number.isFinite(availH) || availH < 160) {
    availH = Math.max(160, window.innerHeight * 0.5);
  }

  return {
    w: Math.min(availW, window.innerWidth - 16),
    h: Math.min(availH, window.innerHeight - 16),
  };
}

function applyBookFrame() {
  const { w, h } = state.pageSize;
  const spread = book.isShowingSpread();
  bookEl.style.setProperty("--page-w", `${w}px`);
  bookEl.style.setProperty("--page-h", `${h}px`);
  bookEl.style.width = `${spread ? w * 2 : w}px`;
  bookEl.style.height = `${h}px`;
  bookWrapEl.style.width = bookEl.style.width;
  bookWrapEl.style.height = `${h}px`;
}

/* ------------------------------------------------------------------------ */
/* Note rendering                                                            */
/* ------------------------------------------------------------------------ */

/** Track currently playing audio so only one plays at a time. */
let activeAudio = null;

function createTextNote(message, { preview = false } = {}) {
  const font = getFont(message.font);
  const note = el("div", { class: `note ${font.className}${preview ? " note--preview" : ""}` }, [
    el("p", { class: "note__text", text: message.text || "" }),
    el("span", { class: "note__name", text: message.name || "" }),
  ]);
  return note;
}

function createVoiceNote(message, { autoplay = false } = {}) {
  const wave = el(
    "span",
    { class: "voice-note__wave", "aria-hidden": "true" },
    Array.from({ length: 14 }, () => el("span")),
  );
  const playBtn = el("button", {
    type: "button",
    class: "voice-note__play",
    "aria-label": `Play voice message from ${message.name}`,
    "aria-pressed": "false",
    text: "▶",
  });
  const duration = el("span", { class: "voice-note__duration", text: formatTime(message.duration) });
  const note = el("div", { class: `voice-note${message.isPrivate ? " voice-note--private" : ""}` }, [
    el("div", { class: "voice-note__row" }, [playBtn, wave, duration]),
    el("span", {
      class: "voice-note__label",
      text: message.isPrivate ? "Private message for Tracey" : "A voice message for you",
    }),
    el("span", { class: "voice-note__name", text: message.name }),
  ]);

  let audio = null;
  let objectUrl = null;

  const setPlaying = (playing) => {
    note.classList.toggle("is-playing", playing);
    playBtn.textContent = playing ? "❚❚" : "▶";
    playBtn.setAttribute("aria-pressed", String(playing));
    playBtn.setAttribute("aria-label", `${playing ? "Pause" : "Play"} voice message from ${message.name}`);
  };

  const togglePlayback = async () => {
    try {
      if (!audio) {
        const url = await CardStore.getAudioUrl(message);
        if (!url) {
          toast("Sorry, this recording could not be loaded.", { type: "error" });
          return;
        }
        objectUrl = url.startsWith("blob:") ? url : null;
        audio = new Audio(url);
        audio.addEventListener("ended", () => {
          setPlaying(false);
          if (activeAudio === audio) activeAudio = null;
        });
        audio.addEventListener("pause", () => setPlaying(false));
        audio.addEventListener("play", () => setPlaying(true));
        audio.addEventListener("timeupdate", () => {
          const remaining = Math.max(0, (message.duration || audio.duration || 0) - audio.currentTime);
          if (Number.isFinite(remaining)) duration.textContent = formatTime(remaining);
        });
      }
      if (audio.paused) {
        if (activeAudio && activeAudio !== audio) activeAudio.pause();
        pauseFeatureVideos();
        activeAudio = audio;
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (err) {
      console.error(err);
      toast("Playback failed. Your browser may not support this audio format.", { type: "error" });
    }
  };

  playBtn.addEventListener("click", togglePlayback);
  if (autoplay) togglePlayback();

  // Release blob URLs when the note is removed from the DOM (re-render).
  note.addEventListener("note:dispose", () => {
    if (audio) audio.pause();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  return note;
}

function createLockedVoiceNote(message) {
  const sender = message.name || "someone";
  const note = el("button", {
    type: "button",
    class: "voice-note voice-note--locked",
    "aria-haspopup": "dialog",
    "aria-label": `Private message for Tracey — from ${sender}. Enter a PIN to listen.`,
  }, [
    el("span", { class: "voice-note__row" }, [
      el("span", { class: "voice-note__play voice-note__lock", "aria-hidden": "true", text: "🔒" }),
    ]),
    el("span", { class: "voice-note__label", text: `Private message for Tracey — from ${sender}` }),
  ]);
  note.addEventListener("click", () => openPinDialog(message, note));
  return note;
}

function voiceCanPlay(message) {
  return Boolean(message && (message.audioPath || message.audioFile));
}

function createNoteElement(message, opts) {
  if (message.type !== "voice") return createTextNote(message, opts);
  if (message.isPrivate && !voiceCanPlay(message) && !isAdmin()) return createLockedVoiceNote(message);
  return createVoiceNote(message, opts);
}

function copyNotePlacement(from, to) {
  ["left", "top", "width", "transform", "animationDelay"].forEach((prop) => {
    to.style[prop] = from.style[prop];
  });
  const spin = from.style.getPropertyValue("--note-transform");
  if (spin) to.style.setProperty("--note-transform", spin);
}

function revealUnlockedVoice(note, message) {
  const player = createVoiceNote(message, { autoplay: true });
  copyNotePlacement(note, player);
  attachAdminDelete(player, message);
  if (note.isConnected) note.replaceWith(player);
}

function applyFeatureVideoRatio() {
  const { w, h } = state.featureVideoRatio;
  document.documentElement.style.setProperty("--feature-video-ratio", `${w} / ${h}`);
}

function probeFeatureVideoRatio() {
  applyFeatureVideoRatio();
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        state.featureVideoRatio = { w: video.videoWidth, h: video.videoHeight };
        applyFeatureVideoRatio();
      }
      video.removeAttribute("src");
      video.load();
      resolve();
    };
    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
    setTimeout(finish, 2000);
    video.src = FEATURE_VIDEO_SRC;
  });
}

function pauseFeatureVideos(except) {
  $$(".feature-video__player", bookEl).forEach((video) => {
    if (except && video === except) return;
    video.pause();
  });
}

function createFeatureVideoCard({ measure = false } = {}) {
  const video = el("video", {
    class: "feature-video__player",
    controls: true,
    playsinline: true,
    preload: "metadata",
  });
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  if (!measure) video.append(el("source", { src: FEATURE_VIDEO_SRC, type: "video/mp4" }));

  video.addEventListener("play", () => {
    if (activeAudio) activeAudio.pause();
    pauseFeatureVideos(video);
  });

  return el("aside", {
    class: "feature-video",
    "aria-label": FEATURE_VIDEO_TITLE,
  }, [
    el("h3", { class: "feature-video__title", text: FEATURE_VIDEO_TITLE }),
    el("p", { class: "feature-video__subtitle", text: FEATURE_VIDEO_SUBTITLE }),
    el("div", { class: "feature-video__frame" }, [video]),
  ]);
}

function featureVideoCardWidth(areaW) {
  if (areaW < 220) return areaW;
  return Math.min(areaW, Math.max(180, Math.round(areaW * 0.46)));
}

function placeFeatureVideo(metrics) {
  const { pad, areaW, areaH } = metrics;
  const cardW = featureVideoCardWidth(areaW);
  const maxCardH = Math.min(areaH, Math.max(120, Math.round(areaH * (areaW < 220 ? 0.46 : 0.34))));
  const ratio = state.featureVideoRatio.h / Math.max(state.featureVideoRatio.w, 1);
  const frameH = Math.max(72, Math.min(Math.round(cardW * ratio), maxCardH - 54));
  const card = createFeatureVideoCard();
  const frame = card.querySelector(".feature-video__frame");
  if (frame) {
    frame.style.height = `${frameH}px`;
    frame.style.aspectRatio = "auto";
  }
  const size = measureFeatureVideo(cardW, maxCardH, card);
  const height = Math.min(Math.max(Math.ceil(size.h + 6), frameH + 36), maxCardH);
  const x = Math.max(0, Math.round((areaW - cardW) / 2));
  card.style.left = `${pad + x}px`;
  card.style.top = `${pad}px`;
  card.style.width = `${cardW}px`;
  card.style.margin = "0 auto";
  card.style.maxHeight = `${height}px`;
  return { card, reserved: { x: 0, y: 0, w: areaW, h: height } };
}

/* Measurement: render a note offscreen at a given width and read its size. */
const measureRoot = $("#measure-root");
function withPageMeasure(fn) {
  measureRoot.style.width = `${state.pageSize.w}px`;
  measureRoot.style.height = `${state.pageSize.h}px`;
  measureRoot.style.containerType = "size";
  try {
    return fn();
  } finally {
    measureRoot.style.height = "";
    measureRoot.style.containerType = "";
  }
}

function measureNote(message, width) {
  return withPageMeasure(() => {
    const node = createNoteElement(message);
    node.style.position = "static";
    node.style.animation = "none";
    node.style.width = `${width}px`;
    measureRoot.append(node);
    const rect = node.getBoundingClientRect();
    node.remove();
    return { w: rect.width, h: rect.height };
  });
}

function measureFeatureVideo(width, maxHeight, existing) {
  return withPageMeasure(() => {
    const node = existing || createFeatureVideoCard({ measure: true });
    const prev = {
      position: node.style.position,
      animation: node.style.animation,
      width: node.style.width,
      maxHeight: node.style.maxHeight,
    };
    node.style.position = "static";
    node.style.animation = "none";
    node.style.width = `${width}px`;
    if (maxHeight) node.style.maxHeight = `${maxHeight}px`;
    measureRoot.append(node);
    const rect = node.getBoundingClientRect();
    node.remove();
    node.style.position = prev.position;
    node.style.animation = prev.animation;
    node.style.width = prev.width;
    node.style.maxHeight = prev.maxHeight;
    return { w: rect.width, h: rect.height };
  });
}

/* ------------------------------------------------------------------------ */
/* Page rendering                                                            */
/* ------------------------------------------------------------------------ */

function createPage(kind, children) {
  return el("article", { class: `page page--${kind}`, role: "group" }, [
    el("div", { class: "page__inner" }, children),
    el("div", { class: "page__back", "aria-hidden": "true" }),
  ]);
}

function renderCover() {
  const flourishTl = el("div", { class: "cover-flourish cover-flourish--tl", html: FLOURISH_SVG, "aria-hidden": "true" });
  const flourishBr = el("div", { class: "cover-flourish cover-flourish--br", html: FLOURISH_SVG, "aria-hidden": "true" });
  const ctaLabel = CardStore.isArchive() ? "Open your card →" : "Turn the page to leave your message →";
  const cta = el("button", {
    type: "button",
    class: "cover-cta",
    text: ctaLabel,
    onclick: () => book.goTo(CONTRIBUTE_INDEX),
  });
  return createPage("cover", [
    el("div", { class: "cover-frame", "aria-hidden": "true" }),
    el("div", { class: "cover-ribbon", "aria-hidden": "true" }),
    flourishTl,
    flourishBr,
    el("h2", { class: "cover-heading" }, [
      el("span", { class: "cover-heading__line", text: "Good Luck In Your New Job." }),
      el("span", { class: "cover-heading__line", text: "We Are All Going To" }),
      el("span", { class: "cover-heading__miss", text: "MISS YOU!!!" }),
    ]),
    el("div", { class: "cover-ornament", "aria-hidden": "true", text: "✦" }),
    el("figure", { class: "cover-photo" }, [
      el("img", {
        class: "cover-photo__img",
        src: COVER_PHOTO_SRC,
        alt: "Photo of Tracey",
        width: 240,
        height: 240,
        onerror: (e) => {
          if (e.target.src.endsWith(COVER_PHOTO_FALLBACK)) return;
          e.target.src = COVER_PHOTO_FALLBACK;
          e.target.alt = "Placeholder for a photo of Tracey";
          e.target.closest(".cover-photo").classList.add("cover-photo--placeholder");
        },
      }),
      el("figcaption", { class: "cover-photo__label", text: "Photo of Tracey" }),
    ]),
    el("p", { class: "cover-for", text: "For Tracey" }),
    cta,
  ]);
}

function renderContributePage() {
  const slot = el("div", { class: "contribute-slot" });
  const controls = $("#contribute-controls");
  if (controls) {
    controls.hidden = CardStore.isArchive();
    slot.append(controls);
  }
  return createPage("contribute", [
    el("div", { class: "page-corner page-corner--tr", html: CORNER_SVG, "aria-hidden": "true" }),
    el("div", { class: "page-corner page-corner--bl", html: CORNER_SVG, "aria-hidden": "true" }),
    el("p", { class: "contribute-kicker", text: "Page 2" }),
    el("h2", { class: "contribute-title", text: "Leave your message" }),
    el("p", {
      class: "contribute-copy",
      html: CardStore.isArchive()
        ? "This is an offline archive of Tracey’s card. Turn the pages to read every note. New messages cannot be added here."
        : "Turn the pages with the arrows, your keyboard’s arrow keys, or by swiping. Use <strong>Add your message</strong> to write a note in your own handwriting style, or <strong>Record a voice message</strong> to leave Tracey a spoken farewell.",
    }),
    slot,
    state.messages.length === 0 && !CardStore.isArchive()
      ? el("p", { class: "contribute-empty", text: "No messages yet — be the first to add a note or a voice message for Tracey." })
      : null,
  ]);
}

function renderMessagePage(placedNotes, pageNumber, totalMessagePages, options = {}) {
  const children = [
    el("div", { class: "page-corner page-corner--tr", html: CORNER_SVG, "aria-hidden": "true" }),
    el("div", { class: "page-corner page-corner--bl", html: CORNER_SVG, "aria-hidden": "true" }),
  ];

  if (options.featureCard) children.push(options.featureCard);

  if (placedNotes.length === 0 && !options.featureCard) {
    children.push(
      el("p", {
        class: "empty-hint",
        text: "No messages yet — be the first to add a note or a voice message for Tracey.",
      }),
    );
  }

  placedNotes.forEach((placed, i) => {
    const node = createNoteElement(placed.message);
    node.style.left = `${placed.left}px`;
    node.style.top = `${placed.top}px`;
    node.style.width = `${placed.width}px`;
    node.style.setProperty("--note-transform", `rotate(${placed.rotation}deg)`);
    node.style.transform = `rotate(${placed.rotation}deg)`;
    node.style.animationDelay = `${Math.min(i * 40, 400)}ms`;
    attachAdminDelete(node, placed.message);
    children.push(node);
  });

  const page = createPage("messages", children);
  page.setAttribute("aria-label", `Messages, page ${pageNumber} of ${totalMessagePages}`);
  return page;
}

function renderFinalPage() {
  return createPage("final", [
    el("div", { class: "cover-frame", "aria-hidden": "true" }),
    el("img", {
      class: "final-bouquet",
      src: "assets/bouquet.svg",
      alt: "Watercolour bouquet of blush roses, ivory blooms, muted lilac flowers and soft green foliage",
      width: 320,
      height: 420,
    }),
    el("p", { class: "final-message" }, [
      el("span", { class: "final-message__line", text: "You have been such a great support to us all —" }),
      el("span", { class: "final-message__line", text: "always calm, collected and positive." }),
      el("span", { class: "final-message__line", text: "We’re all going to miss you dearly." }),
      el("span", { class: "final-message__line", text: "Thank you for everything." }),
    ]),
    el("p", { class: "final-sign", text: "With love from all of us" }),
  ]);
}

function parkContributeControls() {
  const controls = $("#contribute-controls");
  const dock = $("#contribute-dock");
  if (controls && dock) dock.append(controls);
}

function isAdmin() {
  return Boolean(state.adminSession) && !CardStore.isArchive();
}

function attachAdminDelete(node, message) {
  if (!isAdmin() || !message || !message.id) return;
  const btn = el("button", {
    type: "button",
    class: "note-delete",
    "aria-label": `Delete message from ${message.name || "this sender"}`,
    text: "×",
  });
  const stop = (e) => e.stopPropagation();
  btn.addEventListener("pointerdown", stop);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    requestDeleteMessage(message);
  });
  node.append(btn);
}

async function requestDeleteMessage(message) {
  const sender = (message && message.name) || "this sender";
  if (!window.confirm(`Delete this message from ${sender}?`)) return;
  try {
    await CardStore.remove(message);
    state.messages = await CardStore.getAll();
    toast("That message has been removed from the card.");
    render();
  } catch (err) {
    console.error(err);
    toast(err instanceof StorageError ? err.message : "Sorry, that message could not be deleted.", { type: "error" });
  }
}

async function applyAdminSession(session) {
  const nextId = session && session.user && session.user.id;
  const prevId = state.adminSession && state.adminSession.user && state.adminSession.user.id;
  state.adminSession = session || null;
  syncChrome();
  if (nextId === prevId) return;
  try {
    state.messages = await CardStore.getAll();
  } catch (err) {
    console.error(err);
  }
  render();
}

function featureVideoPageIndex() {
  return CONTRIBUTE_INDEX + 1;
}

function featureVideoPageIsVisible(index = book.index) {
  const videoIndex = featureVideoPageIndex();
  if (index === videoIndex) return true;
  return book.isShowingSpread() && index + 1 === videoIndex;
}

function pauseHiddenFeatureVideo() {
  if (!featureVideoPageIsVisible()) pauseFeatureVideos();
}

/** Dispose old notes (revoke blob URLs), then rebuild all pages. */
function render({ focusMessageId = null } = {}) {
  parkContributeControls();
  pauseFeatureVideos();
  $$(".voice-note", bookEl).forEach((n) => n.dispatchEvent(new Event("note:dispose")));
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }

  const size = computePageSize(measureStage().w, measureStage().h);
  state.pageSize = { w: size.w, h: size.h };
  book.setSpreadCapable(size.canSpread);

  const metrics = contentMetrics(state.pageSize.w, state.pageSize.h);
  const feature = placeFeatureVideo(metrics);
  const layout = layoutMessages(state.messages, state.pageSize.w, state.pageSize.h, measureNote, {
    reserveFirstPage: feature.reserved,
  });
  state.pageMap.clear();
  layout.forEach((notes, pageIdx) => notes.forEach((n) => state.pageMap.set(n.message.id, pageIdx + 2)));

  const pages = [renderCover(), renderContributePage()];
  layout.forEach((notes, i) => {
    pages.push(
      renderMessagePage(notes, i + 1, layout.length, i === 0 ? { featureCard: feature.card } : {}),
    );
  });
  pages.push(renderFinalPage());

  bookEl.replaceChildren(...pages);

  let targetIndex = book.index;
  if (focusMessageId && state.pageMap.has(focusMessageId)) {
    targetIndex = state.pageMap.get(focusMessageId);
  }
  book.setPages(pages, targetIndex);
  applyBookFrame();
  syncChrome();
}

/* ------------------------------------------------------------------------ */
/* Book + navigation                                                         */
/* ------------------------------------------------------------------------ */

const indicatorEl = $("#page-indicator");
const btnPrev = $("#btn-prev");
const btnNext = $("#btn-next");
const edgePrev = $("#edge-prev");
const edgeNext = $("#edge-next");

function isOrganiserHost() {
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function contributePageIsVisible(index = book.index) {
  if (index === CONTRIBUTE_INDEX) return true;
  return book.isShowingSpread() && index + 1 === CONTRIBUTE_INDEX;
}

function hasMessageDraft() {
  return Boolean(msgName.value.trim() || msgText.value.trim() || msgState.selectedLibraryText);
}

function hasVoiceDraft() {
  return Boolean(voiceName.value.trim() || rec.blob || (voicePrivate && voicePrivate.checked) || (voicePin && voicePin.value));
}

function syncVoicePrivacy() {
  const on = Boolean(voicePrivate && voicePrivate.checked);
  if (voicePinField) voicePinField.hidden = !on;
  if (!on && voicePin) voicePin.value = "";
  if (!on && voicePinError) setError(voicePin, voicePinError, "");
}

function syncChrome() {
  const index = book.index;
  const total = book.total;
  indicatorEl.textContent = `Page ${index + 1} of ${total}`;
  const atStart = index === 0;
  const atEnd = index === total - 1;
  btnPrev.disabled = atStart;
  edgePrev.disabled = atStart;
  btnNext.disabled = atEnd;
  edgeNext.disabled = atEnd;
  document.body.classList.toggle("on-cover", index === 0);
  document.body.classList.toggle("on-contribute", contributePageIsVisible(index));
  applyBookFrame();

  const adminBtn = $("#btn-admin");
  const adminStatus = $("#admin-status");
  const exportBtn = $("#btn-export");
  const signedIn = Boolean(state.adminSession);
  if (adminBtn) adminBtn.hidden = CardStore.isArchive() || signedIn;
  if (adminStatus) adminStatus.hidden = CardStore.isArchive() || !signedIn;
  if (exportBtn) exportBtn.hidden = CardStore.isArchive() || !isOrganiserHost();
  document.body.classList.toggle("is-admin", signedIn && !CardStore.isArchive());
  const controls = $("#contribute-controls");
  if (controls && !CardStore.isArchive()) {
    controls.hidden = !contributePageIsVisible(index);
  }
}

const book = new Book(bookEl, {
  onChange() {
    pauseHiddenFeatureVideo();
    syncChrome();
  },
});

btnPrev.addEventListener("click", () => book.prev());
btnNext.addEventListener("click", () => book.next());
edgePrev.addEventListener("click", () => book.prev());
edgeNext.addEventListener("click", () => book.next());

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseFeatureVideos();
});
window.addEventListener("pagehide", () => pauseFeatureVideos());

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const next = computePageSize(measureStage().w, measureStage().h);
    if (next.w !== state.pageSize.w || next.h !== state.pageSize.h || next.canSpread !== book.spreadCapable) render();
  }, 150);
});

/* ------------------------------------------------------------------------ */
/* Dialog helpers                                                            */
/* ------------------------------------------------------------------------ */

function setupDialogClose(dialog, onClose) {
  $$("[data-close]", dialog).forEach((btn) => btn.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => onClose && onClose());
  // Clicking the backdrop closes the dialog
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

function setError(input, errorEl, message) {
  errorEl.textContent = message || "";
  if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
}

/* ------------------------------------------------------------------------ */
/* Dialog: written message                                                   */
/* ------------------------------------------------------------------------ */

const msgDialog = $("#dialog-message");
const msgForm = $("#form-message");
const msgName = $("#msg-name");
const msgNameError = $("#msg-name-error");
const msgText = $("#msg-text");
const msgTextError = $("#msg-text-error");
const msgCharCount = $("#msg-char-count");
const libraryEl = $("#library");
const libraryList = $("#library-list");
const librarySearch = $("#library-search");
const libraryError = $("#library-error");
const fontGrid = $("#font-grid");

const msgState = {
  step: 1,
  category: CATEGORIES[0].id,
  selectedLibraryText: null,
  font: DEFAULT_FONT_ID,
};

function buildFontGrid() {
  fontGrid.replaceChildren(
    ...FONTS.map((font) =>
      el("label", { class: "font-option" }, [
        el("input", {
          type: "radio",
          name: "font",
          value: font.id,
          checked: font.id === msgState.font,
          onchange: () => {
            msgState.font = font.id;
            updateLivePreview();
          },
        }),
        el("span", { class: "font-option__body" }, [
          el("span", { class: `font-option__sample ${font.className}`, text: "Good luck, Tracey!" }),
          el("span", { class: "font-option__label", text: font.label }),
        ]),
      ]),
    ),
  );
}

function renderLibraryList() {
  const items = searchLibrary(msgState.category, librarySearch.value);
  if (items.length === 0) {
    libraryList.replaceChildren(el("li", { class: "library__empty", text: "No messages match your search." }));
    return;
  }
  libraryList.replaceChildren(
    ...items.map((text) =>
      el("li", { class: "library__item", role: "presentation" }, [
        el("button", {
          type: "button",
          role: "option",
          "aria-selected": String(text === msgState.selectedLibraryText),
          text,
          onclick: () => {
            msgState.selectedLibraryText = text;
            setError(null, libraryError, "");
            $$("[role=option]", libraryList).forEach((b) => b.setAttribute("aria-selected", String(b.textContent === text)));
          },
        }),
      ]),
    ),
  );
}

/** Swap the preview note with the given id for a freshly rendered one. */
function setPreview(id, draft) {
  const current = document.getElementById(id);
  const preview = createTextNote(draft, { preview: true });
  preview.id = id;
  current.replaceWith(preview);
}

function updateLivePreview() {
  setPreview("msg-live-preview", {
    type: "text",
    name: msgName.value.trim() || "Your name",
    text: msgText.value || "Your message will appear here…",
    font: msgState.font,
  });
  msgCharCount.textContent = `${msgText.value.length} / ${msgText.maxLength}`;
}

function showMsgStep(step) {
  msgState.step = step;
  $$(".step", msgForm).forEach((s) => s.classList.toggle("is-active", Number(s.dataset.step) === step));
  $$(".stepper__step", msgForm).forEach((s) => s.classList.toggle("is-active", Number(s.dataset.step) === step));
  const first = $(".step.is-active input, .step.is-active textarea, .step.is-active button", msgForm);
  if (first) first.focus({ preventScroll: true });
  msgDialog.scrollTop = 0;
}

function resetMsgDialog() {
  msgForm.reset();
  msgState.selectedLibraryText = null;
  msgState.font = DEFAULT_FONT_ID;
  msgState.category = CATEGORIES[0].id;
  libraryEl.hidden = true;
  setError(msgName, msgNameError, "");
  setError(msgText, msgTextError, "");
  setError(null, libraryError, "");
  $$(".tab", libraryEl).forEach((t, i) => {
    t.classList.toggle("is-active", i === 0);
    t.setAttribute("aria-selected", String(i === 0));
  });
  buildFontGrid();
  renderLibraryList();
  showMsgStep(1);
  updateLivePreview();
}

function openMessageDialog() {
  if (!hasMessageDraft()) resetMsgDialog();
  else {
    buildFontGrid();
    renderLibraryList();
    showMsgStep(msgState.step);
    updateLivePreview();
  }
  msgDialog.showModal();
  (msgState.step === 1 ? msgName : msgText).focus({ preventScroll: true });
}

/* Source choice toggles the library */
$$("input[name=source]", msgForm).forEach((radio) =>
  radio.addEventListener("change", () => {
    libraryEl.hidden = radio.value !== "library" || !radio.checked;
    if (!libraryEl.hidden) renderLibraryList();
  }),
);

/* Library tabs + search */
$$(".tab", libraryEl).forEach((tab) =>
  tab.addEventListener("click", () => {
    msgState.category = tab.dataset.category;
    $$(".tab", libraryEl).forEach((t) => {
      const active = t === tab;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", String(active));
    });
    renderLibraryList();
  }),
);
librarySearch.addEventListener("input", renderLibraryList);

/* Step 1 → 2 */
$("#msg-to-step-2").addEventListener("click", () => {
  let ok = true;
  if (!msgName.value.trim()) {
    setError(msgName, msgNameError, "Please tell us your name so Tracey knows who the message is from.");
    ok = false;
  } else {
    setError(msgName, msgNameError, "");
  }

  const source = msgForm.elements.source.value;
  if (source === "library") {
    if (!msgState.selectedLibraryText) {
      setError(null, libraryError, "Please pick a suggested message to start from.");
      ok = false;
    } else {
      setError(null, libraryError, "");
      if (!msgText.value.trim() || msgText.dataset.fromLibrary === "true") {
        msgText.value = msgState.selectedLibraryText;
        msgText.dataset.fromLibrary = "true";
      }
    }
  }
  if (!ok) return;
  updateLivePreview();
  showMsgStep(2);
});

msgText.addEventListener("input", () => {
  msgText.dataset.fromLibrary = "false";
  setError(msgText, msgTextError, "");
  updateLivePreview();
});
msgName.addEventListener("input", () => {
  setError(msgName, msgNameError, "");
  updateLivePreview();
});

$("#msg-back-to-1").addEventListener("click", () => showMsgStep(1));

/* Step 2 → 3 */
$("#msg-to-step-3").addEventListener("click", () => {
  if (!msgText.value.trim()) {
    setError(msgText, msgTextError, "Your message is empty — write a few words for Tracey first.");
    msgText.focus();
    return;
  }
  setError(msgText, msgTextError, "");
  setPreview("msg-review-preview", { type: "text", name: msgName.value.trim(), text: msgText.value.trim(), font: msgState.font });
  showMsgStep(3);
});

$("#msg-back-to-2").addEventListener("click", () => showMsgStep(2));

/* Submit (also fired by pressing Enter in a text field – advance the step instead) */
msgForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (msgState.step === 1) return $("#msg-to-step-2").click();
  if (msgState.step === 2) return $("#msg-to-step-3").click();
  const name = msgName.value.trim();
  const text = msgText.value.trim();
  if (!name || !text) {
    showMsgStep(!name ? 1 : 2);
    return;
  }
  const submitBtn = $("#msg-submit");
  submitBtn.disabled = true;
  try {
    const message = await CardStore.addText({ name, text, font: msgState.font });
    state.messages = await CardStore.getAll();
    resetMsgDialog();
    resetMsgDialog();
    msgDialog.close();
    render({ focusMessageId: message.id });
    toast("Your message has been added to Tracey’s card.");
  } catch (err) {
    console.error(err);
    toast(err instanceof StorageError ? err.message : "Sorry, something went wrong saving your message.", { type: "error" });
  } finally {
    submitBtn.disabled = false;
  }
});

setupDialogClose(msgDialog);
$("#btn-add-message").addEventListener("click", openMessageDialog);

/* ------------------------------------------------------------------------ */
/* Dialog: voice message                                                     */
/* ------------------------------------------------------------------------ */

const voiceDialog = $("#dialog-voice");
const voiceForm = $("#form-voice");
const voiceName = $("#voice-name");
const voiceNameError = $("#voice-name-error");
const voicePrivate = $("#voice-private");
const voicePinField = $("#voice-pin-field");
const voicePin = $("#voice-pin");
const voicePinError = $("#voice-pin-error");
const voiceError = $("#voice-error");
const voiceUnsupported = $("#voice-unsupported");
const recorderEl = $("#recorder");
const recStatus = $("#recorder-status");
const recTimer = $("#recorder-timer");
const recStart = $("#rec-start");
const recStop = $("#rec-stop");
const recPlay = $("#rec-play");
const recDelete = $("#rec-delete");
const recAudio = $("#rec-audio");
const voiceSubmit = $("#voice-submit");

const rec = {
  recorder: null,
  stream: null,
  chunks: [],
  blob: null,
  url: null,
  startedAt: 0,
  duration: 0,
  timerId: null,
  micReady: null,
  audioCtx: null,
  audioSource: null,
  gainNode: null,
  processor: null,
  capturing: false,
  pcmSampleRate: 0,
  pcmPreroll: [],
  pcmChunks: [],
};
let micGeneration = 0;
const PCM_PREROLL_SECONDS = 1.5;

function recordingSupported() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && Ctx);
}

function setRecorderUi({ status, recording = false, hasRecording = false, playing = false }) {
  recStatus.textContent = status;
  recorderEl.classList.toggle("is-recording", recording);
  recorderEl.classList.toggle("is-playing", playing);
  recStart.disabled = recording || hasRecording;
  recStop.disabled = !recording;
  recPlay.disabled = !hasRecording || recording;
  recDelete.disabled = !hasRecording || recording;
  voiceSubmit.disabled = !hasRecording || recording;
  recPlay.textContent = playing ? "❚❚ Pause" : "▶ Play";
}

function liveMicStream() {
  return rec.stream && rec.stream.active && rec.stream.getAudioTracks().some((track) => track.readyState === "live")
    ? rec.stream
    : null;
}

function releaseAudioGraph() {
  rec.capturing = false;
  rec.pcmPreroll = [];
  rec.pcmChunks = [];
  try {
    if (rec.processor) rec.processor.disconnect();
  } catch {
    /* ignore */
  }
  rec.processor = null;
  try {
    if (rec.audioSource) rec.audioSource.disconnect();
  } catch {
    /* ignore */
  }
  try {
    if (rec.gainNode) rec.gainNode.disconnect();
  } catch {
    /* ignore */
  }
  rec.audioSource = null;
  rec.gainNode = null;
  if (rec.audioCtx && rec.audioCtx.state !== "closed") {
    rec.audioCtx.close().catch(() => {});
  }
  rec.audioCtx = null;
}

function stopStream() {
  micGeneration += 1;
  rec.micReady = null;
  releaseAudioGraph();
  if (rec.stream) {
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.stream = null;
  }
}

function primeAudioGraph(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return Promise.resolve();
    if (!rec.audioCtx || rec.audioCtx.state === "closed") {
      rec.audioCtx = new Ctx();
      rec.audioSource = rec.audioCtx.createMediaStreamSource(stream);
      rec.gainNode = rec.audioCtx.createGain();
      rec.gainNode.gain.value = 0;
      rec.audioSource.connect(rec.gainNode);
      rec.gainNode.connect(rec.audioCtx.destination);
      attachPcmTap();
    }
    if (rec.audioCtx.state === "suspended") {
      return rec.audioCtx.resume().then(() => attachPcmTap()).catch(() => {});
    }
    attachPcmTap();
  } catch {
    /* ignore */
  }
  return Promise.resolve();
}

function attachPcmTap() {
  if (!rec.audioCtx || !rec.audioSource || rec.processor) return;
  const processor = rec.audioCtx.createScriptProcessor(1024, 1, 1);
  rec.processor = processor;
  rec.pcmSampleRate = rec.audioCtx.sampleRate;
  rec.pcmPreroll = [];
  rec.pcmChunks = [];
  rec.capturing = false;
  processor.onaudioprocess = (event) => {
    const copy = new Float32Array(event.inputBuffer.getChannelData(0));
    if (rec.capturing) {
      rec.pcmChunks.push(copy);
      return;
    }
    rec.pcmPreroll.push(copy);
    const maxSamples = Math.floor(rec.pcmSampleRate * PCM_PREROLL_SECONDS);
    let samples = 0;
    for (let i = 0; i < rec.pcmPreroll.length; i++) samples += rec.pcmPreroll[i].length;
    while (samples > maxSamples && rec.pcmPreroll.length) samples -= rec.pcmPreroll.shift().length;
  };
  rec.audioSource.connect(processor);
  processor.connect(rec.gainNode || rec.audioCtx.destination);
}

function frameRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(buf.length, 1));
}

function flushPreroll() {
  const frames = rec.pcmPreroll;
  rec.pcmPreroll = [];
  if (!frames.length) return [];
  let start = 0;
  while (start < frames.length && frameRms(frames[start]) < 0.02) start++;
  if (start >= frames.length) return [];
  return frames.slice(start);
}

function trimSilence(samples, sampleRate) {
  const thresh = 0.02;
  const window = Math.max(1, Math.round(sampleRate * 0.02));
  const quietAt = (from) => {
    const end = Math.min(samples.length, Math.max(from, 0) + window);
    const begin = Math.max(0, from);
    if (end <= begin) return true;
    let sum = 0;
    for (let i = begin; i < end; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (end - begin)) < thresh;
  };
  let start = 0;
  while (start < samples.length && quietAt(start)) start += window;
  let end = samples.length;
  while (end > start && quietAt(end - window)) end -= window;
  const pad = Math.round(sampleRate * 0.02);
  start = Math.max(0, start - pad);
  end = Math.min(samples.length, end + pad);
  return samples.subarray(start, Math.max(start + 1, end));
}

function flattenOpeningDip(samples, sampleRate) {
  const headLen = Math.min(samples.length, Math.round(sampleRate * 0.5));
  const restEnd = Math.min(samples.length, headLen + Math.round(sampleRate * 1.2));
  if (restEnd <= headLen + 64) return samples;
  const rms = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, to - from));
  };
  const headRms = rms(0, headLen);
  const restRms = rms(headLen, restEnd);
  if (restRms < 0.03 || headRms >= restRms * 0.8) return samples;
  const boost = Math.min(3.5, restRms / Math.max(headRms, 0.008));
  const out = new Float32Array(samples);
  const fade = Math.max(1, Math.round(sampleRate * 0.2));
  for (let i = 0; i < headLen; i++) {
    const t = i < headLen - fade ? 1 : (headLen - i) / fade;
    const gain = 1 + (boost - 1) * t;
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

function peakNormalize(samples, peak = 0.89) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const amp = Math.abs(samples[i]);
    if (amp > max) max = amp;
  }
  if (max < 0.001) return samples;
  const gain = peak / max;
  if (Math.abs(gain - 1) < 0.04) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  return out;
}

function mergeFloat32(buffers) {
  const total = buffers.reduce((n, buf) => n + buf.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const buf of buffers) {
    out.set(buf, offset);
    offset += buf.length;
  }
  return out;
}

function downsample(input, srcRate, dstRate) {
  if (dstRate === srcRate) return input;
  const ratio = srcRate / dstRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function encodeWav(floatBuf, srcRate) {
  const seconds = floatBuf.length / Math.max(srcRate, 1);
  const rates = [22050, 16000, 12000];
  let dstRate = rates[rates.length - 1];
  for (const rate of rates) {
    if (44 + Math.ceil(seconds * rate) * 2 <= MAX_UPLOAD_BYTES) {
      dstRate = rate;
      break;
    }
  }
  const samples = downsample(floatBuf, srcRate, dstRate);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, dstRate, true);
  view.setUint32(28, dstRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, bytes, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}

function waitForTrackLive(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== "live" || !track.muted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      track.removeEventListener("unmute", finish);
      resolve();
    };
    track.addEventListener("unmute", finish);
    setTimeout(finish, 400);
  });
}

function microphoneErrorMessage(err) {
  const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
  const missing = err && (err.name === "NotFoundError" || err.name === "DevicesNotFoundError");
  if (denied) {
    return "Microphone access was blocked. Please allow microphone access in your browser and try again, or add a written message instead.";
  }
  if (missing) return "We couldn’t find a microphone on this device.";
  return "We couldn’t start recording. Please check your microphone and try again.";
}

function prepareMicrophone() {
  if (!recordingSupported()) return Promise.resolve(null);
  const existing = liveMicStream();
  if (existing) {
    return primeAudioGraph(existing).then(() => existing);
  }
  if (rec.micReady) return rec.micReady;
  const generation = ++micGeneration;
  rec.micReady = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (generation !== micGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    rec.stream = stream;
    await primeAudioGraph(stream);
    await waitForTrackLive(stream);
    if (generation !== micGeneration) return null;
    return stream;
  })().catch((err) => {
    if (generation === micGeneration) {
      rec.micReady = null;
      rec.stream = null;
    }
    throw err;
  });
  return rec.micReady;
}

function resetRecorder() {
  clearInterval(rec.timerId);
  rec.timerId = null;
  rec.capturing = false;
  if (rec.recorder && rec.recorder.state !== "inactive") {
    try {
      rec.recorder.stop();
    } catch {
      /* ignore */
    }
  }
  stopStream();
  if (rec.url) URL.revokeObjectURL(rec.url);
  recAudio.pause();
  recAudio.removeAttribute("src");
  recAudio.load();
  Object.assign(rec, { recorder: null, chunks: [], blob: null, url: null, startedAt: 0, duration: 0 });
  recTimer.textContent = "00:00";
  setError(null, voiceError, "");
  setRecorderUi({ status: "Ready to record" });
}

async function startRecording() {
  setError(null, voiceError, "");
  if (rec.capturing) return;
  if (!liveMicStream()) setRecorderUi({ status: "Starting…" });
  let stream;
  try {
    stream = await prepareMicrophone();
  } catch (err) {
    setError(null, voiceError, microphoneErrorMessage(err));
    setRecorderUi({ status: "Microphone not ready" });
    return;
  }
  if (!stream) {
    setError(null, voiceError, "We couldn’t start recording. Please check your microphone and try again.");
    setRecorderUi({ status: "Microphone not ready" });
    return;
  }
  attachPcmTap();
  if (!rec.processor) {
    setError(null, voiceError, "Recording isn’t supported in this browser. Please try another browser or add a written message.");
    setRecorderUi({ status: "Microphone not ready" });
    return;
  }
  rec.pcmChunks = flushPreroll();
  rec.capturing = true;
  rec.startedAt = Date.now();
  recTimer.textContent = "00:00";
  setRecorderUi({ status: "Recording… speak now", recording: true });

  rec.timerId = setInterval(() => {
    const elapsed = (Date.now() - rec.startedAt) / 1000;
    recTimer.textContent = formatTime(elapsed);
    if (elapsed >= MAX_RECORD_SECONDS) {
      stopRecording();
      toast(`Recordings are limited to ${MAX_RECORD_SECONDS / 60} minutes, so we’ve stopped it for you.`);
    }
  }, 250);
}

function finishRecording() {
  rec.capturing = false;
  clearInterval(rec.timerId);
  rec.timerId = null;
  const frames = rec.pcmChunks;
  rec.pcmChunks = [];
  if (!frames.length) {
    setError(null, voiceError, "We didn’t catch any audio. Please try recording again.");
    setRecorderUi({ status: "Ready to record" });
    return;
  }
  const rate = Math.max(rec.pcmSampleRate, 1);
  let merged = mergeFloat32(frames);
  merged = trimSilence(merged, rate);
  merged = flattenOpeningDip(merged, rate);
  merged = peakNormalize(merged);
  rec.duration = Math.max(1, Math.round(merged.length / rate));
  rec.blob = encodeWav(merged, rate);
  if (rec.blob.size > MAX_UPLOAD_BYTES) {
    rec.blob = null;
    setRecorderUi({ status: "Recording too large" });
    setError(null, voiceError, "That recording is larger than 5 MB. Delete it and record a shorter message.");
    return;
  }
  if (rec.url) URL.revokeObjectURL(rec.url);
  rec.url = URL.createObjectURL(rec.blob);
  recAudio.src = rec.url;
  recTimer.textContent = formatTime(rec.duration);
  setRecorderUi({ status: `Recording ready (${formatTime(rec.duration)}). Listen back before adding it.`, hasRecording: true });
}

function stopRecording() {
  if (!rec.capturing) return;
  setRecorderUi({ status: "Finishing…", recording: false });
  recStart.disabled = true;
  rec.capturing = false;
  // Let the current audio buffer flush into pcmChunks before encoding.
  setTimeout(finishRecording, 80);
}

recStart.addEventListener("click", () => {
  if (!voiceName.value.trim()) {
    setError(voiceName, voiceNameError, "Please enter your name before recording.");
    voiceName.focus();
    return;
  }
  setError(voiceName, voiceNameError, "");
  startRecording();
});
recStop.addEventListener("click", stopRecording);
recPlay.addEventListener("click", async () => {
  if (!rec.url) return;
  try {
    if (recAudio.paused) await recAudio.play();
    else recAudio.pause();
  } catch {
    setError(null, voiceError, "Playback failed. Try re-recording.");
  }
});
recAudio.addEventListener("play", () => setRecorderUi({ status: "Playing back…", hasRecording: true, playing: true }));
recAudio.addEventListener("pause", () =>
  setRecorderUi({ status: `Recording ready (${formatTime(rec.duration)}). Listen back before adding it.`, hasRecording: true }),
);
recAudio.addEventListener("ended", () =>
  setRecorderUi({ status: `Recording ready (${formatTime(rec.duration)}). Listen back before adding it.`, hasRecording: true }),
);
recDelete.addEventListener("click", () => {
  resetRecorder();
  recStart.focus();
  prepareMicrophone()
    .then(() => {
      if (!rec.blob && !rec.capturing) {
        setRecorderUi({ status: "Ready to record" });
      }
    })
    .catch(() => {});
});
voiceName.addEventListener("input", () => setError(voiceName, voiceNameError, ""));
if (voicePrivate) voicePrivate.addEventListener("change", syncVoicePrivacy);
if (voicePin) voicePin.addEventListener("input", () => setError(voicePin, voicePinError, ""));

voiceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = voiceName.value.trim();
  const isPrivate = Boolean(voicePrivate && voicePrivate.checked);
  const pin = voicePin ? voicePin.value.trim() : "";
  if (!name) {
    setError(voiceName, voiceNameError, "Please enter your name.");
    voiceName.focus();
    return;
  }
  if (!rec.blob) {
    setError(null, voiceError, "Record a message first, then add it to the card.");
    return;
  }
  if (isPrivate && !/^\d{4}$/.test(pin)) {
    setError(voicePin, voicePinError, "Enter a 4-digit PIN.");
    if (voicePin) voicePin.focus();
    return;
  }
  voiceSubmit.disabled = true;
  try {
    const message = await CardStore.addVoice({
      name,
      blob: rec.blob,
      duration: rec.duration,
      isPrivate,
      pin: isPrivate ? pin : "",
    });
    state.messages = await CardStore.getAll();
    resetRecorder();
    voiceForm.reset();
    syncVoicePrivacy();
    voiceDialog.close();
    render({ focusMessageId: message.id });
    toast(isPrivate
      ? "Your private voice message has been added. It stays locked until the PIN is entered."
      : "Your voice message has been added to Tracey’s card.");
  } catch (err) {
    console.error(err);
    setError(null, voiceError, err instanceof StorageError ? err.message : "Sorry, we couldn’t save your recording.");
    voiceSubmit.disabled = false;
  }
});

function openVoiceDialog() {
  if (!hasVoiceDraft()) {
    voiceForm.reset();
    setError(voiceName, voiceNameError, "");
    setError(voicePin, voicePinError, "");
    resetRecorder();
  }
  syncVoicePrivacy();
  const supported = recordingSupported();
  voiceUnsupported.hidden = supported;
  $(".recorder__controls").hidden = !supported;
  $(".recorder__status").hidden = !supported;
  $(".recorder__bars").hidden = !supported;
  voiceDialog.showModal();
  voiceName.focus({ preventScroll: true });
  if (supported && !rec.blob) {
    setRecorderUi({ status: "Getting the microphone ready…" });
    prepareMicrophone()
      .then((stream) => {
        if (!stream || rec.blob || rec.capturing) return;
        setRecorderUi({ status: "Ready to record" });
      })
      .catch((err) => {
        setError(null, voiceError, microphoneErrorMessage(err));
        setRecorderUi({ status: "Microphone not ready" });
      });
  }
}

setupDialogClose(voiceDialog, () => {
  if (rec.capturing) {
    resetRecorder();
    return;
  }
  if (!rec.blob) stopStream();
});
$("#btn-add-voice").addEventListener("click", openVoiceDialog);

/* ------------------------------------------------------------------------ */
/* Private voice PIN                                                         */
/* ------------------------------------------------------------------------ */

const pinDialog = $("#dialog-pin");
const pinForm = $("#form-pin");
const pinInput = $("#pin-input");
const pinError = $("#pin-error");
const pinSubmit = $("#pin-submit");
let pendingUnlock = null;

function openPinDialog(message, note) {
  pendingUnlock = { message, note };
  if (pinError) pinError.textContent = "";
  if (pinForm) pinForm.reset();
  if (!pinDialog) return;
  pinDialog.showModal();
  if (pinInput) pinInput.focus({ preventScroll: true });
}

if (pinForm) {
  pinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pendingUnlock) return;
    const pin = pinInput ? pinInput.value : "";
    if (!String(pin).trim()) {
      if (pinError) pinError.textContent = "Enter the 4-digit PIN or master passcode.";
      return;
    }
    if (pinSubmit) pinSubmit.disabled = true;
    const { message, note } = pendingUnlock;
    try {
      const audioPath = await CardStore.unlockVoice(message.id, pin);
      message.audioPath = audioPath;
      if (pinForm) pinForm.reset();
      if (pinDialog) pinDialog.close();
      if (note && note.isConnected) revealUnlockedVoice(note, message);
      else render({ focusMessageId: message.id });
    } catch (err) {
      console.error(err);
      if (pinError) pinError.textContent = err instanceof StorageError ? err.message : "Incorrect PIN";
    } finally {
      if (pinSubmit) pinSubmit.disabled = false;
    }
  });
}
if (pinDialog) {
  setupDialogClose(pinDialog, () => {
    pendingUnlock = null;
  });
}

/* ------------------------------------------------------------------------ */
/* Admin sign-in (Supabase Auth) and localhost archive export                 */
/* ------------------------------------------------------------------------ */

const adminLoginDialog = $("#dialog-admin-login");
const adminLoginForm = $("#form-admin-login");
const adminEmail = $("#admin-email");
const adminPassword = $("#admin-password");
const adminLoginError = $("#admin-login-error");
const adminLoginSubmit = $("#admin-login-submit");
const adminDialog = $("#dialog-admin");
const adminExport = $("#admin-export");

function openAdminLogin() {
  if (CardStore.isArchive() || !CardStore.isConfigured()) return;
  if (adminLoginError) adminLoginError.textContent = "";
  if (adminLoginForm) adminLoginForm.reset();
  adminLoginDialog.showModal();
  if (adminEmail) adminEmail.focus({ preventScroll: true });
}

if (adminLoginForm) {
  adminLoginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (adminLoginError) adminLoginError.textContent = "";
    const email = adminEmail ? adminEmail.value.trim() : "";
    const password = adminPassword ? adminPassword.value : "";
    if (!email || !password) {
      if (adminLoginError) adminLoginError.textContent = "Enter your email and password.";
      return;
    }
    if (adminLoginSubmit) adminLoginSubmit.disabled = true;
    try {
      const session = await CardStore.signIn(email, password);
      await applyAdminSession(session);
      adminLoginForm.reset();
      adminLoginDialog.close();
      toast("Admin mode is on. You can delete messages from the card.");
    } catch (err) {
      if (adminLoginError) {
        adminLoginError.textContent = err instanceof StorageError ? err.message : "Sign-in failed. Check the email and password.";
      }
    } finally {
      if (adminLoginSubmit) adminLoginSubmit.disabled = false;
    }
  });
}
if (adminLoginDialog) setupDialogClose(adminLoginDialog);

const adminBtn = $("#btn-admin");
if (adminBtn) {
  adminBtn.addEventListener("click", () => {
    if (CardStore.isArchive()) return;
    if (!CardStore.isConfigured()) {
      toast("The shared card is not connected yet.", { type: "error" });
      return;
    }
    openAdminLogin();
  });
}
const adminLogout = $("#btn-admin-logout");
if (adminLogout) {
  adminLogout.addEventListener("click", async () => {
    try {
      await CardStore.signOut();
    } catch (err) {
      console.error(err);
    }
    await applyAdminSession(null);
    toast("Signed out of admin mode.");
  });
}

if (adminExport) {
  adminExport.addEventListener("click", async () => {
    if (!isOrganiserHost() || CardStore.isArchive()) return;
    adminExport.disabled = true;
    try {
      const result = await LC.archive.exportCard();
      toast(`Archive downloaded (${result.count} message${result.count === 1 ? "" : "s"}).`);
    } catch (err) {
      console.error(err);
      toast(err.message || "The archive could not be created.", { type: "error" });
    } finally {
      adminExport.disabled = false;
    }
  });
}
if (adminDialog) {
  setupDialogClose(adminDialog);
}
const exportBtn = $("#btn-export");
if (exportBtn) {
  exportBtn.addEventListener("click", () => {
    if (!isOrganiserHost() || CardStore.isArchive()) return;
    adminDialog.showModal();
  });
}

/* ------------------------------------------------------------------------ */
/* Boot                                                                      */
/* ------------------------------------------------------------------------ */

async function init() {
  const addBtn = $("#btn-add-message");
  const voiceBtn = $("#btn-add-voice");
  const ratioReady = probeFeatureVideoRatio();
  if (CardStore.isArchive()) {
    if (addBtn) addBtn.hidden = true;
    if (voiceBtn) voiceBtn.hidden = true;
  } else if (!CardStore.isConfigured()) {
    if (addBtn) addBtn.disabled = true;
    if (voiceBtn) voiceBtn.disabled = true;
    toast(
      "The shared card is not connected yet. Add the Supabase Project URL and anon public key to js/supabase-config.js.",
      { type: "error", duration: 9000 },
    );
    await ratioReady;
    render();
    return;
  }

  try {
    const session = await CardStore.getSession().catch(() => null);
    state.adminSession = session;
    const messages = await CardStore.getAll();
    await ratioReady;
    state.messages = messages;
  } catch (err) {
    await ratioReady;
    toast(err instanceof StorageError ? err.message : "Could not load the shared card.", { type: "error", duration: 8000 });
    render();
    return;
  }
  try {
    CardStore.onAuthChange((session) => applyAdminSession(session));
  } catch (err) {
    console.error(err);
  }
  render();
  await preloadFonts();
  render();
}

init().catch((err) => {
  console.error(err);
  toast("Something went wrong loading the card. Please refresh the page.", { type: "error" });
});

// Expose a small debug/test surface (handy for QA and for a future backend swap).
LC.app = { state, render, book };
})(window.LeavingCard = window.LeavingCard || {});
