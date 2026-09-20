import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyDeskUpload,
  applyFilesToChooser,
  armDownloadWatch,
  armFileChooser,
  cancelFileChooser,
  classifyDeskFiles,
  createChooserRegistry,
  DOWNLOAD_MAX_BYTES,
  FILE_EMPTY,
  FILE_NEED_CHAT,
  FILE_NOT_ADDED,
  FILE_TOO_BIG,
  FILE_UPLOAD_MAX,
  safeUploadName,
  sanitizeDownloadName,
  scheduleUploadWipe,
} from "../lib/file-chooser.mjs";
import { deskUploadDir, extractTarEntry, packUstar, resolveDeskDownload } from "../lib/desk-files.mjs";

describe("exclusive VNC local file apply", () => {
  it("rejects oversized and empty uploads with a Chinese error", () => {
    assert.equal(classifyDeskFiles([]).error, FILE_EMPTY);
    assert.equal(classifyDeskFiles([{ name: "a.pdf", data: "" }]).error, FILE_EMPTY);
    const big = Buffer.alloc(FILE_UPLOAD_MAX + 1, 1);
    const over = classifyDeskFiles([{ name: "big.pdf", bytes: big }]);
    assert.equal(over.ok, false);
    assert.equal(over.status, 413);
    assert.equal(over.error, FILE_TOO_BIG);
    assert.equal(over.error, "文件太大，请选择 12MB 以内的文件");
    const ok = classifyDeskFiles([{ name: "note.txt", mime: "text/plain", bytes: Buffer.from("hi") }]);
    assert.equal(ok.ok, true);
    assert.equal(ok.files[0].name, "note.txt");
  });

  it("strips remote paths from filenames", () => {
    assert.equal(safeUploadName("../../etc/passwd"), "passwd");
    assert.equal(safeUploadName("C:\\\\Users\\\\a\\\\报告.docx"), "报告.docx");
    assert.equal(safeUploadName(""), "file");
    assert.equal(deskUploadDir("abC12").startsWith("/tmp/gpc-up-"), true);
  });

  it("intercepts the remote chooser and applies local files, or cancels", async () => {
    const calls = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      return {};
    };
    const listeners = [];
    await armFileChooser({
      send,
      sessionId: "s1",
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      onOpened: (info) => {
        calls.push({ opened: info });
      },
    });
    assert.equal(calls.some((c) => c.method === "Page.setInterceptFileChooserDialog" && c.params.enabled === true), true);
    assert.equal(
      calls.some(
        (c) =>
          (c.method === "Browser.setDownloadBehavior" || c.method === "Page.setDownloadBehavior") &&
          c.params.behavior === "allow" &&
          /gpc-downloads/.test(c.params.downloadPath || ""),
      ),
      true,
    );
    listeners[0]({
      method: "Page.fileChooserOpened",
      sessionId: "s1",
      params: { backendNodeId: 44, mode: "selectMultiple" },
    });
    assert.equal(calls.some((c) => c.opened?.backendNodeId === 44), true);

    await applyFilesToChooser(send, { backendNodeId: 44, paths: ["/tmp/gpc-up-x/a.pdf"] });
    const set = calls.find((c) => c.method === "DOM.setFileInputFiles");
    assert.deepEqual(set.params, { files: ["/tmp/gpc-up-x/a.pdf"], backendNodeId: 44 });

    await cancelFileChooser(send, { backendNodeId: 44 });
    const cancel = calls.filter((c) => c.method === "DOM.setFileInputFiles").at(-1);
    assert.deepEqual(cancel.params.files, []);
  });

  it("applyDeskUpload uses staged paths and wipes them on exclusive VNC", async () => {
    const wiped = [];
    const sent = [];
    const out = await applyDeskUpload({
      files: [
        {
          name: "brief.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: Buffer.from("PK"),
        },
      ],
      targetId: "t-vnc",
      pending: { backendNodeId: 7, targetId: "t-vnc" },
      attach: async () => ({
        cdp: {
          send: async (method, params) => {
            sent.push({ method, params });
            if (method === "Runtime.evaluate") {
              return { result: { value: /names\.length/.test(params.expression || "") ? 1 : true } };
            }
            return {};
          },
        },
        sessionId: "s",
        release: async () => {},
      }),
      stage: async (files) => {
        assert.equal(files[0].name, "brief.docx");
        return { paths: ["/tmp/gpc-up-1/brief.docx"], wipe: async () => wiped.push(1) };
      },
    });
    assert.equal(out.ok, true);
    const set = sent.find((c) => c.method === "DOM.setFileInputFiles");
    assert.deepEqual(set.params.files, ["/tmp/gpc-up-1/brief.docx"]);
    assert.equal(set.params.backendNodeId, 7);
    // The evidence probe was armed before the apply and polls saw the change event.
    const evals = sent.filter((c) => c.method === "Runtime.evaluate").map((c) => c.params.expression);
    assert.equal(evals.some((e) => /__gpcUp/.test(e) && /addEventListener/.test(e)), true);
    assert.equal(evals.some((e) => /names\.length/.test(e)), true);
    // ChatGPT reads the bytes lazily — the staged file must survive the apply tick.
    assert.deepEqual(wiped, []);
  });

  it("reports FILE_NOT_ADDED when no apply lands on a live input", async () => {
    const wiped = [];
    const sent = [];
    const out = await applyDeskUpload({
      files: [{ name: "a.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF") }],
      targetId: "t-vnc",
      pending: { backendNodeId: 9, targetId: "t-vnc" },
      evidenceWaitMs: 40,
      attach: async () => ({
        cdp: {
          send: async (method, params) => {
            sent.push({ method, params });
            if (method === "Runtime.evaluate") {
              return { result: { value: /names\.length/.test(params.expression || "") ? 0 : true } };
            }
            return {};
          },
        },
        sessionId: "s",
        release: async () => {},
      }),
      stage: async () => ({ paths: ["/tmp/gpc-up-9/a.pdf"], wipe: async () => wiped.push(1) }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, FILE_NOT_ADDED);
    // The stale-node path kept failing, so the drop fallback fired too.
    assert.equal(sent.filter((c) => c.method === "DOM.setFileInputFiles").length >= 1, true);
    assert.equal(sent.some((c) => c.method === "Input.dispatchDragEvent"), true);
    assert.deepEqual(wiped, [1]);
  });

  it("scheduleUploadWipe deletes the staged dir after the keep window", async () => {
    const wiped = [];
    const cancel = scheduleUploadWipe(async () => wiped.push(1), 40);
    assert.deepEqual(wiped, []);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(wiped, [1]);
    cancel();
  });

  it("deletes the staged file with the page when the apply fails", async () => {
    const wiped = [];
    await assert.rejects(
      () =>
        applyDeskUpload({
          files: [{ name: "a.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF") }],
          targetId: "t-vnc",
          pending: { backendNodeId: 3, targetId: "t-vnc" },
          attach: async () => {
            throw new Error("无法连接页面");
          },
          stage: async () => ({ paths: ["/tmp/gpc-up-2/a.pdf"], wipe: async () => wiped.push(1) }),
        }),
      /无法连接页面/,
    );
    assert.deepEqual(wiped, [1]);
  });

  it("applies pdf and images through the exclusive CDP pipe without 多人分屏", async () => {
    const sent = [];
    const pdf = await applyDeskUpload({
      files: [{ name: "a.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF") }],
      targetId: "t-vnc",
      pending: { backendNodeId: 3, targetId: "t-vnc" },
      attach: async () => ({
        cdp: {
          send: async (method, params) => {
            sent.push({ method, params });
            if (method === "Runtime.evaluate") {
              return { result: { value: /names\.length/.test(params.expression || "") ? 1 : true } };
            }
            return {};
          },
        },
        sessionId: "s",
        release: async () => {},
      }),
      stage: async () => ({ paths: ["/tmp/gpc-up-1/a.pdf"], wipe: async () => {} }),
    });
    assert.equal(pdf.ok, true);
    assert.equal(sent.some((c) => c.method === "DOM.setFileInputFiles"), true);
    const missing = await applyDeskUpload({
      files: [{ name: "a.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF") }],
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, FILE_NEED_CHAT);
  });

  it("chooser registry hands a pending open to a waiter", async () => {
    const reg = createChooserRegistry();
    const waiting = reg.wait("a", "u1", 200);
    reg.set("a", "u1", { backendNodeId: 3, mode: "selectSingle", targetId: "t" });
    const got = await waiting;
    assert.equal(got.backendNodeId, 3);
    assert.equal(reg.take("a", "u1").targetId, "t");
    assert.equal(reg.get("a", "u1"), null);
  });

  it("packs an ustar that names the staged file", () => {
    const tar = packUstar([
      { name: "gpc-up-aa", directory: true },
      { name: "gpc-up-aa/note.txt", bytes: Buffer.from("hello") },
    ]);
    assert.equal(tar.length % 512, 0);
    assert.equal(tar.toString("utf8", 0, 20).startsWith("gpc-up-aa"), true);
    const fileHdr = tar.subarray(512, 1024).toString("utf8");
    assert.match(fileHdr, /gpc-up-aa\/note\.txt/);
  });

  it("sanitizes download filenames for the save dialog", () => {
    assert.equal(sanitizeDownloadName("../../etc/passwd"), "passwd");
    assert.equal(sanitizeDownloadName(""), "download");
    assert.equal(sanitizeDownloadName("C:\\Users\\a\\报告 v2.pdf"), "报告 v2.pdf");
    assert.match(sanitizeDownloadName("evil\u0000name.txt"), /evilname\.txt/);
  });

  it("extracts only the named root entry from a docker archive tar", () => {
    const tar = packUstar([
      { name: "report.pdf", bytes: Buffer.from("%PDF-1.4 hello") },
      { name: "nested/trick.txt", bytes: Buffer.from("nope") },
    ]);
    assert.equal(extractTarEntry(tar, "report.pdf").toString("utf8"), "%PDF-1.4 hello");
    assert.equal(extractTarEntry(tar, "trick.txt"), null);
    assert.equal(extractTarEntry(tar, "missing.pdf"), null);
    assert.equal(extractTarEntry(Buffer.alloc(1024), "x"), null);
  });

  it("waits for the desk download to settle before reading it", async () => {
    const sizes = new Map();
    const polls = [];
    const out = await resolveDeskDownload("report.pdf", {
      readdir: async () => [...sizes.keys()],
      stat: async (p) => {
        const n = p.split("/").pop();
        if (!sizes.has(n)) throw new Error("ENOENT");
        return { size: sizes.get(n) };
      },
      sleep: async () => {
        polls.push(1);
        if (polls.length === 1) sizes.set("report.pdf", 10);
        if (polls.length === 2) sizes.set("report.pdf", 2048);
      },
    });
    assert.deepEqual(out, { name: "report.pdf", size: 2048 });
    const miss = await resolveDeskDownload("report.pdf", {
      readdir: async () => [],
      stat: async () => {
        throw new Error("ENOENT");
      },
      sleep: async () => {},
      timeoutMs: 1,
    });
    assert.equal(miss, null);
  });

  it("arms download events and surfaces finished pulls", async () => {
    const calls = [];
    const listeners = [];
    const finished = [];
    await armDownloadWatch({
      send: async (method, params) => calls.push({ method, params }),
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      onDownload: (info) => finished.push(info),
    });
    assert.equal(
      calls.some(
        (c) =>
          c.method === "Browser.setDownloadBehavior" &&
          c.params.eventsEnabled === true &&
          c.params.behavior === "default" &&
          /gpc-downloads/.test(c.params.downloadPath || ""),
      ),
      true,
    );
    listeners[0]({ method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "报告 v2.pdf" } });
    listeners[0]({ method: "Browser.downloadProgress", params: { guid: "g1", state: "inProgress", receivedBytes: 5, totalBytes: 90 } });
    assert.equal(finished.length, 0);
    listeners[0]({ method: "Browser.downloadProgress", params: { guid: "g1", state: "completed", totalBytes: 90 } });
    assert.equal(finished.length, 1);
    assert.equal(finished[0].name, "报告 v2.pdf");
    assert.equal(finished[0].size, 90);
    listeners[0]({ method: "Browser.downloadProgress", params: { guid: "g1", state: "completed", totalBytes: 90 } });
    assert.equal(finished.length, 1);
    const before = finished.length;
    listeners[0]({ method: "Browser.downloadWillBegin", params: { guid: "g2", suggestedFilename: "big.bin" } });
    listeners[0]({
      method: "Browser.downloadProgress",
      params: { guid: "g2", state: "completed", totalBytes: DOWNLOAD_MAX_BYTES + 1 },
    });
    assert.equal(finished.length, before);
  });
});
