# Tracey’s Leaving Card

An interactive digital A4 leaving card. Colleagues can add handwritten-style notes (in one of six handwriting fonts) or record a voice message. Pages turn like a book, the number of message pages grows automatically, and everything is saved on the device so it survives a refresh.

Built with plain **HTML, CSS and vanilla JavaScript**. No build step or dependencies.

## Running locally

**Simplest:** double-click `index.html` to open it in Chrome, Edge, Firefox or Safari. The scripts are plain (non-module) scripts, so the card works directly from disk.

**Recommended for sharing on a network:** serve the folder with any static server, for example:

```powershell
# Python 3
python -m http.server 8080

# or Node (no install needed)
npx serve .
```

Then open <http://localhost:8080>.

Notes:

- Microphone recording requires a secure context. `localhost` and `file://` both count as secure in modern browsers; if you host the card on another machine, use HTTPS.
- Fonts are loaded from Google Fonts, so an internet connection is needed for the handwriting styles. For offline use, download the six handwriting fonts plus Playfair Display / Cormorant Garamond and replace the `<link>` in `index.html` with `@font-face` rules.
- Messages are stored per browser, per device. For a shared card where everyone contributes from their own machine, host it and swap the storage adapter for a backend (see below).

## Using the card

- **Turn pages** with the arrow buttons, your keyboard’s ← / → keys, by clicking/tapping the page edges, or by swiping on touch devices.
- **Add your message**: enter your name, write your own note or pick one from the message library (Good Luck / Farewell & Good Luck / Funny Congratulations), choose a handwriting style, preview, review and submit.
- **Record a voice message**: enter your name, record, listen back, re-record if you like, then add it. Voice notes appear on the card with a play/pause control.
- **Admin → Reset card** (bottom of the page) clears every message on this device. It requires typing `RESET` to confirm.

## Replacing the placeholders

| Placeholder | File | Notes |
| --- | --- | --- |
| Photo of Tracey | `assets/tracey.jpg` | The cover loads this file; if it's missing, `assets/tracey-placeholder.svg` is shown with a "Photo of Tracey" label. Swap the JPG to change the photo (the crop position is set by `object-position` on `.cover-photo__img`). |
| Flower bouquet | `assets/bouquet.svg` | Replace with any image; keep roughly square for best results. |

## Project structure

```
index.html              Markup: header, book stage, dialogs
css/styles.css          All styling, page-turn animation, responsive rules
js/app.js               UI wiring: rendering, dialogs, recorder, boot
js/book.js              Page stacking + 3D page-turn, keyboard & swipe input
js/layout.js            Scatter/pagination engine (seeded, non-overlapping)
js/fonts.js             The six handwriting fonts + preloading
js/messages-library.js  Predefined message library (3 categories)
js/storage.js           Storage adapter (localStorage + IndexedDB)
assets/                 Placeholder SVGs
```

## How layout & pagination work

`js/layout.js` measures each note offscreen at a width chosen from its length, rotates it between −4° and +4°, then finds a free spot on the current page using seeded random attempts followed by a systematic scan. If nothing fits, a new page is started. Because the random seed is derived from each message’s id, the layout is stable across refreshes, and because the page size is derived from the viewport, pagination adapts on resize.

## Swapping local storage for a backend

All persistence goes through `CardStore` in `js/storage.js`, and every method is `async`. To move to a database/API, implement the same interface against your backend and nothing in the UI needs to change:

```js
export const CardStore = {
  isAvailable(): boolean,
  async getAll(): Promise<Message[]>,                              // oldest first
  async addText({ name, text, font }): Promise<Message>,
  async addVoice({ name, blob, duration }): Promise<Message>,       // upload the Blob
  async getAudioUrl(message): Promise<string | null>,              // playable URL
  async remove(id): Promise<void>,
  async clear(): Promise<void>,
};
```

Message shape:

```ts
{
  id: string;
  type: "text" | "voice";
  name: string;
  text?: string;       // text messages
  font?: string;       // one of the ids in js/fonts.js
  duration?: number;   // seconds, voice messages
  mimeType?: string;   // voice messages
  createdAt: string;   // ISO timestamp
}
```

## Browser support

Modern evergreen browsers. Voice recording depends on `MediaRecorder`; a friendly fallback message is shown where it is unavailable. The app degrades gracefully if `localStorage` or `IndexedDB` is blocked (messages then last for the session only, and audio falls back to Base64 in `localStorage`).
