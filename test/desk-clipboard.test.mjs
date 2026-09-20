import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLIP_IMAGE_TYPES,
  interpretPageClip,
  isDeskOutboundFilePath,
  PAGE_CLIP_READ,
  preferCopiedClip,
  needsPageClipboard,
  sniffImageMime,
} from "../lib/desk-clipboard.mjs";

describe("desk clipboard + download isolation", () => {
  it("blocks Kasm/kclient paths that would pull inner downloads to the viewer", () => {
    assert.equal(isDeskOutboundFilePath("/Downloads/report.pdf"), true);
    assert.equal(isDeskOutboundFilePath("/downloads/a.png"), true);
    assert.equal(isDeskOutboundFilePath("/vnc/Downloads/Downloads/a.png"), true);
    assert.equal(isDeskOutboundFilePath("/api/downloads"), true);
    assert.equal(isDeskOutboundFilePath("/api/downloads/list"), true);
    assert.equal(isDeskOutboundFilePath("/files"), true);
    assert.equal(isDeskOutboundFilePath("/files/socket.io/?EIO=4"), true);
    assert.equal(isDeskOutboundFilePath("/vnc/index.html"), false);
    assert.equal(isDeskOutboundFilePath("/vnc/app/images/download.gif"), false);
    assert.equal(isDeskOutboundFilePath("/api/desks/a/copy"), false);
    assert.equal(isDeskOutboundFilePath("/websockify"), false);
  });

  it("sniffs png/jpeg/webp/bmp and rejects short or random bytes", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    assert.equal(sniffImageMime(png), "image/png");
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
    assert.equal(sniffImageMime(jpeg), "image/jpeg");
    const webp = Buffer.concat([Buffer.from("RIFF....WEBP", "ascii"), Buffer.alloc(24, 3)]);
    webp.write("RIFF", 0);
    webp.write("WEBP", 8);
    assert.equal(sniffImageMime(webp), "image/webp");
    assert.equal(sniffImageMime(Buffer.from("hello world this is not an image!!")), "");
    assert.equal(sniffImageMime(Buffer.from([0x89, 0x50])), "");
  });

  it("interprets page clipboard images without treating text as png", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);
    const got = interpretPageClip({ kind: "image", mime: "image/png", b64: png.toString("base64") });
    assert.equal(got.kind, "image");
    assert.equal(got.mime, "image/png");
    assert.equal(got.buf.equals(png), true);
    const text = interpretPageClip({ kind: "text", text: "https://chatgpt.com/share/abc" });
    assert.equal(text.kind, "text");
    assert.equal(text.buf.toString("utf8"), "https://chatgpt.com/share/abc");
    assert.equal(interpretPageClip({ kind: "image", b64: Buffer.from("nope").toString("base64") }), null);
    assert.equal(interpretPageClip("selected text").kind, "text");
    assert.ok(CLIP_IMAGE_TYPES.includes("image/png"));
    assert.match(PAGE_CLIP_READ, /clipboard\.read/);
    assert.match(PAGE_CLIP_READ, /image/);
  });

  it("lets a fresh text selection win, but not leftover X11 text over a ChatGPT PNG", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 9)]);
    const leftover = { kind: "text", mime: "text/plain; charset=utf-8", buf: Buffer.from("old") };
    const selected = { kind: "text", mime: "text/plain; charset=utf-8", buf: Buffer.from("new selection") };
    const image = { kind: "image", mime: "image/png", buf: png };
    const fromSelect = preferCopiedClip({ before: leftover, grabbed: selected, page: image });
    assert.equal(fromSelect.kind, "text");
    assert.equal(fromSelect.buf.toString("utf8"), "new selection");
    const fromCopyBtn = preferCopiedClip({ before: leftover, grabbed: leftover, page: image });
    assert.equal(fromCopyBtn.kind, "image");
    const kept = preferCopiedClip({ before: image, grabbed: { kind: "text", mime: "text/plain", buf: Buffer.from("") }, page: null });
    assert.equal(kept.kind, "image");
    assert.equal(needsPageClipboard(leftover, selected), false);
    assert.equal(needsPageClipboard(leftover, leftover), true);
    assert.equal(needsPageClipboard(leftover, image), false);
  });
});
