/**
 * Exclusive-VNC clipboard + download isolation.
 * ChatGPT image copy uses the async Clipboard API; do not inject Ctrl+C
 * over that. Inner-browser downloads stay in the desk — never published
 * through Kasm's web Downloads folder or kclient /files.
 */

export const CLIP_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/bmp"];

export function isDeskOutboundFilePath(pathname) {
  const p = String(pathname || "").split("?")[0].toLowerCase();
  if (p === "/downloads" || p.startsWith("/downloads/")) return true;
  if (p === "/vnc/downloads" || p.startsWith("/vnc/downloads/")) return true;
  if (p === "/api/downloads" || p.startsWith("/api/downloads")) return true;
  if (p === "/files" || p.startsWith("/files/")) return true;
  return false;
}

export function sniffImageMime(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 24) return "";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x42 && b[1] === 0x4d && b.length > 14) return "image/bmp";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "";
}

/**
 * Runtime.evaluate body. Reads the page clipboard (images first, then text)
 * without writing X11 — ChatGPT's Copy button already put the PNG there.
 */
export const PAGE_CLIP_READ = `(() => {
  return (async () => {
    const toB64 = (bytes) => {
      const chunk = 0x2000;
      let bin = "";
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = (item.types || []).find((t) => /^image\\/(png|jpeg|jpg|webp|bmp)$/i.test(t));
          if (!type) continue;
          const blob = await item.getType(type);
          const buf = new Uint8Array(await blob.arrayBuffer());
          if (buf.length < 24) continue;
          const mime = type === "image/jpg" ? "image/jpeg" : type;
          return { kind: "image", mime, b64: toB64(buf) };
        }
      }
    } catch (e) {}
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const t = await navigator.clipboard.readText();
        if (t) return { kind: "text", text: t };
      }
    } catch (e) {}
    const sel = (document.getSelection && document.getSelection().toString()) || "";
    return { kind: "text", text: sel };
  })();
})()`;

export function interpretPageClip(value) {
  if (typeof value === "string") {
    return { kind: "text", mime: "text/plain; charset=utf-8", buf: Buffer.from(value, "utf8") };
  }
  if (!value || typeof value !== "object") return null;
  if (value.kind === "image" && typeof value.b64 === "string" && value.b64) {
    const buf = Buffer.from(value.b64, "base64");
    const sniffed = sniffImageMime(buf);
    if (!sniffed) return null;
    const mime = CLIP_IMAGE_TYPES.includes(value.mime) ? value.mime : sniffed;
    return { kind: "image", mime, buf };
  }
  if (typeof value.text === "string") {
    return { kind: "text", mime: "text/plain; charset=utf-8", buf: Buffer.from(value.text, "utf8") };
  }
  return null;
}

function clipOf(got) {
  if (!got?.buf?.length) return null;
  const kind = got.kind === "image" ? "image" : "text";
  const mime = String(got.mime || got.ct || (kind === "image" ? "image/png" : "text/plain; charset=utf-8")).split(";")[0].trim();
  return { kind, mime: kind === "image" ? mime : got.mime || got.ct || "text/plain; charset=utf-8", buf: got.buf };
}

function sameClip(a, b) {
  if (!a?.buf || !b?.buf || a.buf.length !== b.buf.length) return false;
  return Buffer.compare(a.buf, b.buf) === 0;
}

/**
 * Fresh text selection wins over a leftover PNG. Leftover X11 text must not
 * hide a PNG ChatGPT just wrote (async clipboard often never reaches xclip).
 */
export function preferCopiedClip({ before, grabbed, page } = {}) {
  const grabbedText = grabbed?.kind === "text" && grabbed.buf?.toString("utf8").trim();
  if (grabbedText && !sameClip(grabbed, before)) return clipOf(grabbed);
  if (page?.kind === "image" && page.buf.length > 24) return clipOf(page);
  const pageText = page?.kind === "text" && page.buf?.toString("utf8").trim();
  if (pageText && !sameClip(page, before)) return clipOf(page);
  if (grabbed?.kind === "image" && grabbed.buf.length > 24) return clipOf(grabbed);
  if (grabbed?.buf?.length) return clipOf(grabbed);
  if (before?.buf?.length) return clipOf(before);
  return null;
}

/** Skip the CDP page read when X11 already has a fresh selection or a PNG. */
export function needsPageClipboard(before, grabbed) {
  if (grabbed?.kind === "image" && grabbed.buf?.length > 24) return false;
  const grabbedText = grabbed?.kind === "text" && grabbed.buf?.toString("utf8").trim();
  if (grabbedText && !sameClip(grabbed, before)) return false;
  return true;
}
