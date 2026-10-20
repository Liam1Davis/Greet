/**
 * Offline archive export.
 *
 * Builds a ZIP (store method, no compression) that contains the complete card,
 * embedded message data, images, downloaded fonts, and original audio files.
 * The ZIP’s index.html opens from disk without a server or network.
 *
 * Exposed on window.LeavingCard.archive = { exportCard }.
 */
(function (LC) {
"use strict";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeUtf8(str) {
  return new TextEncoder().encode(str);
}

function u16(n) {
  const b = new Uint8Array(2);
  const v = new DataView(b.buffer);
  v.setUint16(0, n, true);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  v.setUint32(0, n >>> 0, true);
  return b;
}

function concat(parts) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** ZIP store (method 0) so the archive needs no extra libraries to open. */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const nameBytes = encodeUtf8(file.name.replace(/\\/g, "/"));
    const data = file.data instanceof Uint8Array ? file.data : encodeUtf8(String(file.data));
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    locals.push(local);
    centrals.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(dosTime),
        u16(dosDate),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    );
    offset += local.length;
  }

  const central = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, central, end]);
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not include ${url} in the archive (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not include ${url} in the archive (${res.status}).`);
  return res.text();
}

function localFontCss(cssText, renameMap) {
  return cssText.replace(/url\((['"]?)(https:[^)'"]+)\1\)/g, (match, quote, url) => {
    const local = renameMap.get(url);
    return local ? `url("${local}")` : match;
  });
}

async function collectFonts(files) {
  const href = document.querySelector('link[href*="fonts.googleapis.com"]')?.href;
  if (!href) return "";
  const css = await fetchText(href);
  const urls = [...css.matchAll(/url\((['"]?)(https:[^)'"]+)\1\)/g)].map((m) => m[2]);
  const renameMap = new Map();
  let i = 0;
  for (const url of urls) {
    const ext = (url.split(".").pop() || "woff2").split("?")[0];
    const localName = `fonts/face-${i}.${ext}`;
    renameMap.set(url, localName);
    files.push({ name: localName, data: await fetchBytes(url) });
    i += 1;
  }
  return localFontCss(css, renameMap);
}

function buildArchiveIndexHtml(original, hasLocalFonts) {
  let html = original;
  html = html.replace(
    /<link\s+rel="preconnect"[^>]*>\s*/g,
    "",
  );
  if (hasLocalFonts) {
    html = html.replace(
      /<link[\s\S]*?fonts\.googleapis\.com[\s\S]*?>/,
      '<link rel="stylesheet" href="css/archive-fonts.css" />',
    );
  }
  html = html.replace(
    /<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"[^>]*><\/script>\s*/g,
    "",
  );
  html = html.replace(
    '<script defer src="js/supabase-config.js"></script>',
    '<script defer src="js/archive-data.js"></script>',
  );
  return html;
}

async function exportCard() {
  const { CardStore } = LC.storage;
  if (!CardStore || CardStore.isArchive()) {
    throw new Error("The live card is required to build an archive.");
  }
  const messages = await CardStore.getAll();
  const files = [];
  const archived = [];

  for (const message of messages) {
    const copy = { ...message };
    if (message.type === "voice" && message.audioPath) {
      const blob = await CardStore.getAudioBlob(message);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const fileName = `audio/${message.audioPath}`;
      files.push({ name: fileName, data: bytes });
      copy.audioFile = fileName;
    }
    archived.push(copy);
  }

  const archiveData = `window.LEAVING_CARD_ARCHIVE = ${JSON.stringify(
    { generatedAt: new Date().toISOString(), messages: archived },
    null,
    2,
  )};\n`;
  files.push({ name: "js/archive-data.js", data: encodeUtf8(archiveData) });

  const page = await fetchText("index.html");
  let fontCss = "";
  try {
    fontCss = await collectFonts(files);
  } catch {
    fontCss = "";
  }
  if (fontCss) files.push({ name: "css/archive-fonts.css", data: encodeUtf8(fontCss) });
  files.push({ name: "index.html", data: encodeUtf8(buildArchiveIndexHtml(page, Boolean(fontCss))) });

  const staticFiles = [
    "css/styles.css",
    "js/fonts.js",
    "js/messages-library.js",
    "js/storage.js",
    "js/layout.js",
    "js/book.js",
    "js/archive.js",
    "js/app.js",
    "assets/bouquet.svg",
    "assets/tracey-placeholder.svg",
    "assets/tracey.jpg",
    "Video/Parrot-AI-20261019-Tracey.mp4",
  ];
  for (const name of staticFiles) {
    try {
      files.push({ name, data: await fetchBytes(name) });
    } catch {
      if (name !== "assets/tracey.jpg") throw new Error(`Missing ${name}; the archive would be incomplete.`);
    }
  }

  const zip = buildZip(files);
  const blob = new Blob([zip], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "traceys-leaving-card-archive.zip";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { count: archived.length, bytes: zip.length };
}

LC.archive = { exportCard, buildZip, crc32, buildArchiveIndexHtml };
})(window.LeavingCard = window.LeavingCard || {});
