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
const { layoutMessages } = LC.layout;
const { Book } = LC;

/* ------------------------------------------------------------------------ */
/* Constants & state                                                         */
/* ------------------------------------------------------------------------ */

const A4_RATIO = Math.SQRT2; // long side / short side
const MAX_LANDSCAPE_WIDTH = 1123; // A4 landscape @ 96dpi
const MAX_PORTRAIT_WIDTH = 794;
const MAX_RECORD_SECONDS = 120;

/** Tracey's photo. If this file is missing the placeholder is shown instead. */
const COVER_PHOTO_SRC = "assets/tracey.jpg";
const COVER_PHOTO_FALLBACK = "assets/tracey-placeholder.svg";

const COVER_HEADING = "Good Luck In Your New Job and We Are Going To Miss You!!!";
const FINAL_MESSAGE = "You will never be forgotten. Thank you for everything you have done for us.";

const state = {
  messages: [],
  pageSize: { w: 0, h: 0 },
  pageMap: new Map(), // message id → page index (for jumping to a new note)
  persistent: true,
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

function computePageSize() {
  const stageRect = stageEl.getBoundingClientRect();
  const styles = getComputedStyle(stageEl);
  const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);

  const navVisible = getComputedStyle($("#btn-prev")).display !== "none";
  const navAllowance = navVisible ? 2 * (46 + 12) : 0;

  const availW = Math.max(280, stageRect.width - padX - navAllowance);
  const availH = Math.max(320, stageRect.height - padY);

  let w;
  let h;
  if (availW >= availH) {
    // Landscape A4
    w = Math.min(MAX_LANDSCAPE_WIDTH, availW);
    h = w / A4_RATIO;
    if (h > availH) {
      h = availH;
      w = h * A4_RATIO;
    }
  } else {
    // Portrait A4 (small / tall screens)
    w = Math.min(MAX_PORTRAIT_WIDTH, availW);
    h = w * A4_RATIO;
    if (h > availH) {
      h = availH;
      w = h / A4_RATIO;
    }
  }
  return { w: Math.floor(w), h: Math.floor(h) };
}

function applyPageSize(size) {
  state.pageSize = size;
  bookEl.style.width = `${size.w}px`;
  bookEl.style.height = `${size.h}px`;
  bookWrapEl.style.width = `${size.w}px`;
  bookWrapEl.style.height = `${size.h}px`;
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

function createVoiceNote(message) {
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
  const note = el("div", { class: "voice-note" }, [
    el("div", { class: "voice-note__row" }, [playBtn, wave, duration]),
    el("span", { class: "voice-note__label", text: "A voice message for you" }),
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

  playBtn.addEventListener("click", async () => {
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
        activeAudio = audio;
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (err) {
      console.error(err);
      toast("Playback failed. Your browser may not support this audio format.", { type: "error" });
    }
  });

  // Release blob URLs when the note is removed from the DOM (re-render).
  note.addEventListener("note:dispose", () => {
    if (audio) audio.pause();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  return note;
}

function createNoteElement(message, opts) {
  return message.type === "voice" ? createVoiceNote(message) : createTextNote(message, opts);
}

/* Measurement: render a note offscreen at a given width and read its size. */
const measureRoot = $("#measure-root");
function measureNote(message, width) {
  measureRoot.style.width = `${state.pageSize.w}px`;
  const node = createNoteElement(message);
  node.style.position = "static";
  node.style.animation = "none";
  node.style.width = `${width}px`;
  measureRoot.append(node);
  const rect = node.getBoundingClientRect();
  node.remove();
  return { w: rect.width, h: rect.height };
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
  return createPage("cover", [
    el("div", { class: "cover-frame", "aria-hidden": "true" }),
    el("div", { class: "cover-ribbon", "aria-hidden": "true" }),
    flourishTl,
    flourishBr,
    el("h2", { class: "cover-heading", text: COVER_HEADING }),
    el("div", { class: "cover-ornament", "aria-hidden": "true", text: "✦" }),
    el("figure", { class: "cover-photo" }, [
      el("img", {
        class: "cover-photo__img",
        src: COVER_PHOTO_SRC,
        alt: "Photo of Tracey",
        width: 240,
        height: 240,
        onerror: (e) => {
          // Photo not found: show the labelled placeholder instead.
          if (e.target.src.endsWith(COVER_PHOTO_FALLBACK)) return;
          e.target.src = COVER_PHOTO_FALLBACK;
          e.target.alt = "Placeholder for a photo of Tracey";
          e.target.closest(".cover-photo").classList.add("cover-photo--placeholder");
        },
      }),
      el("figcaption", { class: "cover-photo__label", text: "Photo of Tracey" }),
    ]),
    el("p", { class: "cover-for", text: "For Tracey" }),
  ]);
}

function renderMessagePage(placedNotes, pageNumber, totalMessagePages) {
  const children = [
    el("div", { class: "page-corner page-corner--tr", html: CORNER_SVG, "aria-hidden": "true" }),
    el("div", { class: "page-corner page-corner--bl", html: CORNER_SVG, "aria-hidden": "true" }),
  ];

  if (placedNotes.length === 0) {
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
      alt: "A bouquet of flowers",
      width: 380,
      height: 380,
    }),
    el("p", { class: "final-message", text: FINAL_MESSAGE }),
    el("p", { class: "final-sign", text: "With love from all of us" }),
  ]);
}

/** Dispose old notes (revoke blob URLs), then rebuild all pages. */
function render({ focusMessageId = null } = {}) {
  $$(".voice-note", bookEl).forEach((n) => n.dispatchEvent(new Event("note:dispose")));
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }

  applyPageSize(computePageSize());

  const layout = layoutMessages(state.messages, state.pageSize.w, state.pageSize.h, measureNote);
  state.pageMap.clear();
  layout.forEach((notes, pageIdx) => notes.forEach((n) => state.pageMap.set(n.message.id, pageIdx + 1)));

  const pages = [renderCover()];
  layout.forEach((notes, i) => pages.push(renderMessagePage(notes, i + 1, layout.length)));
  pages.push(renderFinalPage());

  bookEl.replaceChildren(...pages);

  let targetIndex = book.index;
  if (focusMessageId && state.pageMap.has(focusMessageId)) {
    targetIndex = state.pageMap.get(focusMessageId);
  }
  book.setPages(pages, targetIndex);
}

/* ------------------------------------------------------------------------ */
/* Book + navigation                                                         */
/* ------------------------------------------------------------------------ */

const indicatorEl = $("#page-indicator");
const btnPrev = $("#btn-prev");
const btnNext = $("#btn-next");
const edgePrev = $("#edge-prev");
const edgeNext = $("#edge-next");

const book = new Book(bookEl, {
  onChange(index, total) {
    indicatorEl.textContent = `Page ${index + 1} of ${total}`;
    const atStart = index === 0;
    const atEnd = index === total - 1;
    btnPrev.disabled = atStart;
    edgePrev.disabled = atStart;
    btnNext.disabled = atEnd;
    edgeNext.disabled = atEnd;
  },
});

btnPrev.addEventListener("click", () => book.prev());
btnNext.addEventListener("click", () => book.next());
edgePrev.addEventListener("click", () => book.prev());
edgeNext.addEventListener("click", () => book.next());

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const next = computePageSize();
    if (next.w !== state.pageSize.w || next.h !== state.pageSize.h) render();
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
  resetMsgDialog();
  msgDialog.showModal();
  msgName.focus({ preventScroll: true });
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
    state.messages.push(message);
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
};

function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && globalThis.MediaRecorder);
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
  if (!globalThis.MediaRecorder?.isTypeSupported) return "";
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
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

function stopStream() {
  if (rec.stream) {
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.stream = null;
  }
}

function resetRecorder() {
  clearInterval(rec.timerId);
  rec.timerId = null;
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
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    const missing = err && (err.name === "NotFoundError" || err.name === "DevicesNotFoundError");
    setError(
      null,
      voiceError,
      denied
        ? "Microphone access was blocked. Please allow microphone access in your browser and try again, or add a written message instead."
        : missing
          ? "We couldn’t find a microphone on this device."
          : "We couldn’t start recording. Please check your microphone and try again.",
    );
    return;
  }

  const mimeType = pickMimeType();
  let recorder;
  try {
    recorder = mimeType ? new MediaRecorder(rec.stream, { mimeType }) : new MediaRecorder(rec.stream);
  } catch (err) {
    stopStream();
    setError(null, voiceError, "Recording isn’t supported in this browser. Please try another browser or add a written message.");
    return;
  }
  rec.recorder = recorder;

  rec.chunks = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) rec.chunks.push(e.data);
  });
  recorder.addEventListener("stop", () => {
    // Ignore if the dialog was closed / reset while recording.
    if (rec.recorder !== recorder) return;
    clearInterval(rec.timerId);
    rec.timerId = null;
    stopStream();
    rec.duration = Math.max(1, Math.round((Date.now() - rec.startedAt) / 1000));
    rec.blob = new Blob(rec.chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    if (rec.url) URL.revokeObjectURL(rec.url);
    rec.url = URL.createObjectURL(rec.blob);
    recAudio.src = rec.url;
    recTimer.textContent = formatTime(rec.duration);
    setRecorderUi({ status: `Recording ready (${formatTime(rec.duration)}). Listen back before adding it.`, hasRecording: true });
  });

  recorder.start(250);
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

function stopRecording() {
  if (rec.recorder && rec.recorder.state === "recording") {
    rec.recorder.stop();
    setRecorderUi({ status: "Finishing…", recording: false });
    recStart.disabled = true;
  }
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
});
voiceName.addEventListener("input", () => setError(voiceName, voiceNameError, ""));

voiceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = voiceName.value.trim();
  if (!name) {
    setError(voiceName, voiceNameError, "Please enter your name.");
    voiceName.focus();
    return;
  }
  if (!rec.blob) {
    setError(null, voiceError, "Record a message first, then add it to the card.");
    return;
  }
  voiceSubmit.disabled = true;
  try {
    const message = await CardStore.addVoice({ name, blob: rec.blob, duration: rec.duration });
    state.messages.push(message);
    voiceDialog.close();
    render({ focusMessageId: message.id });
    toast("Your voice message has been added to Tracey’s card.");
  } catch (err) {
    console.error(err);
    setError(null, voiceError, err instanceof StorageError ? err.message : "Sorry, we couldn’t save your recording.");
    voiceSubmit.disabled = false;
  }
});

function openVoiceDialog() {
  voiceForm.reset();
  setError(voiceName, voiceNameError, "");
  resetRecorder();
  const supported = recordingSupported();
  voiceUnsupported.hidden = supported;
  $(".recorder__controls").hidden = !supported;
  $(".recorder__status").hidden = !supported;
  $(".recorder__bars").hidden = !supported;
  voiceDialog.showModal();
  voiceName.focus({ preventScroll: true });
}

setupDialogClose(voiceDialog, resetRecorder);
$("#btn-add-voice").addEventListener("click", openVoiceDialog);

/* ------------------------------------------------------------------------ */
/* Dialog: admin reset                                                       */
/* ------------------------------------------------------------------------ */

const adminDialog = $("#dialog-admin");
const adminForm = $("#form-admin");
const adminConfirm = $("#admin-confirm");
const adminReset = $("#admin-reset");

adminConfirm.addEventListener("input", () => {
  adminReset.disabled = adminConfirm.value.trim().toUpperCase() !== "RESET";
});
adminForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (adminConfirm.value.trim().toUpperCase() !== "RESET") return;
  await CardStore.clear();
  state.messages = [];
  adminDialog.close();
  book.index = 0;
  render();
  toast("The card has been reset.");
});
setupDialogClose(adminDialog, () => {
  adminForm.reset();
  adminReset.disabled = true;
});
$("#btn-admin").addEventListener("click", () => {
  adminForm.reset();
  adminReset.disabled = true;
  adminDialog.showModal();
});

/* ------------------------------------------------------------------------ */
/* Boot                                                                      */
/* ------------------------------------------------------------------------ */

async function init() {
  state.persistent = CardStore.isAvailable();
  if (!state.persistent) {
    toast("Local storage isn’t available, so messages will only last until you close this tab.", { type: "error", duration: 7000 });
  }

  // First paint with system fonts, then re-layout once handwriting fonts are ready
  // (font metrics change the measured note sizes).
  state.messages = await CardStore.getAll();
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
