/**
 * Remote ChatGPT file inputs must not open the desk's Linux picker.
 * Exclusive VNC uses CDP as a private pipe: intercept
 * Page.fileChooserOpened, let the user's OS pick, then apply via
 * DOM.setFileInputFiles (paths staged in the desk container).
 * This is not 多人分屏 / tab seats.
 */

export const FILE_UPLOAD_MAX = 12 * 1024 * 1024;
export const FILE_UPLOAD_MAX_COUNT = 8;
export const FILE_TOO_BIG = "文件太大，请选择 12MB 以内的文件";
export const FILE_EMPTY = "空文件";
export const FILE_UPLOAD_FAIL = "无法上传文件";
export const FILE_NEED_CHAT = "请先在对话里点回形针再选文件";

export function safeUploadName(name) {
  const base = String(name || "file")
    .split(/[/\\]/)
    .pop()
    .replace(/^\.+/, "");
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 120);
  return cleaned || "file";
}

export function classifyDeskFiles(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { ok: false, error: FILE_EMPTY, status: 400 };
  if (list.length > FILE_UPLOAD_MAX_COUNT) {
    return { ok: false, error: FILE_TOO_BIG, status: 413 };
  }
  let total = 0;
  const out = [];
  for (const f of list) {
    const bytes = Buffer.isBuffer(f?.bytes)
      ? f.bytes
      : typeof f?.data === "string"
        ? Buffer.from(f.data, "base64")
        : Buffer.from(f?.bytes || []);
    if (!bytes.length) return { ok: false, error: FILE_EMPTY, status: 400 };
    total += bytes.length;
    if (total > FILE_UPLOAD_MAX || bytes.length > FILE_UPLOAD_MAX) {
      return { ok: false, error: FILE_TOO_BIG, status: 413 };
    }
    out.push({
      name: safeUploadName(f.name),
      mime: String(f.mime || "application/octet-stream").split(";")[0].trim() || "application/octet-stream",
      bytes,
    });
  }
  return { ok: true, files: out };
}

export function fileChooserClientMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.type === "file-chooser") {
    return {
      type: "file-chooser",
      mode: msg.mode === "selectMultiple" ? "selectMultiple" : "selectSingle",
    };
  }
  if (msg.type === "file-chooser-done") {
    return { type: "file-chooser-done", ok: !!msg.ok, error: String(msg.error || "") };
  }
  return null;
}

export const DOWNLOAD_FAIL = "下载没拿到，请再点一次";
export const DOWNLOAD_CANCELLED = "已取消下载";
export const DOWNLOAD_RETENTION_MS = 10 * 60 * 1000;
/** In-memory pull for the user's save dialog. Bigger files stay in the desk. */
export const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

export function sanitizeDownloadName(name) {
  const base = String(name || "download")
    .split(/[/\\]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/^\.+/, "");
  const cleaned = base.replace(/[^\w.一-鿿 -]+/g, "_").slice(0, 120).trim();
  return cleaned || "download";
}

/**
 * Reverse of the upload pipe: watch Chromium's own downloads and pull the
 * finished file out so the occupant's browser can save it locally.
 * Exclusive VNC only — tab seats stream pixels, not the desk filesystem.
 */
export async function armDownloadWatch({ send, on, onDownload } = {}) {
  if (typeof send !== "function" || typeof on !== "function") return { armed: false, dispose() {} };
  const downloads = new Map();
  let currentGuid = "";

  await send("Browser.setDownloadBehavior", {
    behavior: "default",
    eventsEnabled: true,
    downloadPath: DESK_DOWNLOAD_DIR,
  });

  const off =
    typeof on === "function"
      ? on((msg) => {
          if (msg?.method === "Browser.downloadWillBegin") {
            const p = msg.params || {};
            const guid = String(p.guid || "");
            if (!guid) return;
            currentGuid = guid;
            downloads.set(guid, {
              guid,
              name: sanitizeDownloadName(p.suggestedFilename),
              state: "progressing",
              received: 0,
              total: 0,
            });
            return;
          }
          if (msg?.method !== "Browser.downloadProgress") return;
          const p = msg.params || {};
          const guid = String(p.guid || "");
          const entry = downloads.get(guid) || (guid && guid === currentGuid ? downloads.get(currentGuid) : null);
          if (!entry) return;
          entry.state = String(p.state || "inProgress");
          entry.received = Number(p.receivedBytes) || entry.received;
          entry.total = Number(p.totalBytes) || entry.total;
          if (entry.state === "inProgress" || entry.state === "progressing") return;
          downloads.delete(entry.guid);
          if (entry.state !== "completed") return;
          if (entry.total > DOWNLOAD_MAX_BYTES) return;
          onDownload?.({
            guid: entry.guid,
            name: entry.name,
            size: entry.total || entry.received || 0,
            savedAt: Date.now(),
          });
        })
      : () => {};

  return {
    armed: true,
    dispose() {
      try {
        off?.();
      } catch {
        /* ignore */
      }
      send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: DESK_DOWNLOAD_DIR,
      }).catch(() => {});
    },
  };
}

/** Keep ChatGPT downloads inside the desk. Do not let Kasm publish ~/Downloads. */
export const DESK_DOWNLOAD_DIR = "/config/gpc-downloads";

export async function keepDeskDownloadsInside(send) {
  if (typeof send !== "function") return false;
  for (const origin of ["https://chatgpt.com", "https://chat.openai.com"]) {
    try {
      await send("Browser.grantPermissions", {
        origin,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
    } catch {
      /* clipboard.read still works in many Chromium builds without this */
    }
  }
  try {
    await send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: DESK_DOWNLOAD_DIR,
    });
    return true;
  } catch {
    try {
      await send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: DESK_DOWNLOAD_DIR,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export async function armFileChooser({ send, on, sessionId, onOpened } = {}) {
  if (typeof send !== "function") return { armed: false, dispose() {} };
  await send("Page.enable", {}, sessionId);
  await send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
  await keepDeskDownloadsInside((method, params) => send(method, params, ""));
  const off =
    typeof on === "function"
      ? on((msg) => {
          if (msg?.method !== "Page.fileChooserOpened") return;
          if (sessionId && msg.sessionId && msg.sessionId !== sessionId) return;
          const params = msg.params || {};
          onOpened?.({
            backendNodeId: params.backendNodeId,
            mode: params.mode === "selectMultiple" ? "selectMultiple" : "selectSingle",
          });
        })
      : () => {};
  return {
    armed: true,
    dispose() {
      try {
        off?.();
      } catch {
        /* ignore */
      }
      send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId).catch(() => {});
    },
  };
}

export async function applyFilesToChooser(send, { backendNodeId, nodeId, objectId, paths } = {}) {
  const files = (paths || []).filter(Boolean);
  const params = { files };
  if (backendNodeId) params.backendNodeId = backendNodeId;
  if (nodeId) params.nodeId = nodeId;
  if (objectId) params.objectId = objectId;
  await send("DOM.setFileInputFiles", params);
}

export async function cancelFileChooser(send, { backendNodeId, nodeId } = {}) {
  if (!backendNodeId && !nodeId) return;
  const params = { files: [] };
  if (backendNodeId) params.backendNodeId = backendNodeId;
  if (nodeId) params.nodeId = nodeId;
  await send("DOM.setFileInputFiles", params);
}

export async function findFileInputNode(send) {
  await send("DOM.enable", {});
  const doc = await send("DOM.getDocument", { depth: 0, pierce: true });
  const root = doc?.root?.nodeId;
  if (!root) return 0;
  const all = await send("DOM.querySelectorAll", { nodeId: root, selector: "input[type=file]" });
  const ids = all?.nodeIds || [];
  return ids[ids.length - 1] || 0;
}

export async function dropFilesOnPage(send, { x, y, paths } = {}) {
  const files = (paths || []).filter(Boolean);
  const px = Math.max(0, Number(x) || 640);
  const py = Math.max(0, Number(y) || 400);
  const data = {
    items: files.map((p) => ({ mimeType: "text/uri-list", data: `file://${p}` })),
    files,
    dragOperationsMask: 1,
  };
  await send("Input.dispatchDragEvent", { type: "dragEnter", x: px, y: py, data });
  await send("Input.dispatchDragEvent", { type: "dragOver", x: px, y: py, data });
  await send("Input.dispatchDragEvent", { type: "drop", x: px, y: py, data });
}

export function createChooserRegistry() {
  const pending = new Map();
  const waiters = new Map();

  const keyOf = (deskId, userId) => `${deskId}:${userId}`;

  return {
    set(deskId, userId, info) {
      const key = keyOf(deskId, userId);
      pending.set(key, { ...info, deskId, userId, at: Date.now() });
      const q = waiters.get(key) || [];
      waiters.delete(key);
      for (const fn of q) {
        try {
          fn(pending.get(key));
        } catch {
          /* ignore */
        }
      }
      return pending.get(key);
    },
    get(deskId, userId) {
      return pending.get(keyOf(deskId, userId)) || null;
    },
    take(deskId, userId) {
      const key = keyOf(deskId, userId);
      const info = pending.get(key) || null;
      pending.delete(key);
      return info;
    },
    clear(deskId, userId) {
      pending.delete(keyOf(deskId, userId));
    },
    wait(deskId, userId, ms = 20_000) {
      const existing = this.get(deskId, userId);
      if (existing) return Promise.resolve(existing);
      const key = keyOf(deskId, userId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const q = (waiters.get(key) || []).filter((fn) => fn !== onOpen);
          if (q.length) waiters.set(key, q);
          else waiters.delete(key);
          resolve(null);
        }, ms);
        const onOpen = (info) => {
          clearTimeout(timer);
          resolve(info);
        };
        waiters.set(key, [...(waiters.get(key) || []), onOpen]);
      });
    },
  };
}

/**
 * ChatGPT reads the input's bytes lazily after DOM.setFileInputFiles — the
 * upload fetch to files.oaiusercontent.com starts on the change event. Deleting
 * the staged file in the same tick makes that read fail (ENOENT) and ChatGPT
 * reports it as a network error. Keep the file around for the page, mop up later.
 */
export const UPLOAD_KEEP_MS = 60 * 60 * 1000;

export function scheduleUploadWipe(wipe, ms = UPLOAD_KEEP_MS) {
  if (typeof wipe !== "function") return () => {};
  let timer = null;
  try {
    timer = setTimeout(() => {
      try {
        Promise.resolve(wipe()).catch(() => {});
      } catch {
        /* ignore */
      }
    }, ms);
    timer.unref?.();
  } catch {
    /* no timers — dir stays until container restart */
  }
  return () => {
    if (timer) clearTimeout(timer);
  };
}

/**
 * Apply user-picked bytes to the remote ChatGPT file input.
 * stage() writes temp paths the desk Chromium can see; wipe after apply.
 * Always uses the exclusive-VNC CDP pipe — not tab seats.
 */
export async function applyDeskUpload({
  files,
  cancel = false,
  drop = null,
  pending = null,
  targetId = "",
  attach,
  stage,
} = {}) {
  if (cancel) {
    if (pending && typeof attach === "function") {
      const attached = await attach(targetId || pending.targetId);
      try {
        await cancelFileChooser(
          (method, params) => attached.cdp.send(method, params, attached.sessionId),
          pending,
        );
      } finally {
        await attached.release?.();
      }
    }
    return { ok: true, cancelled: true };
  }

  const classified = classifyDeskFiles(files);
  if (!classified.ok) return classified;

  const tid = targetId || pending?.targetId;
  if (!tid) return { ok: false, error: FILE_NEED_CHAT, status: 409 };
  if (typeof attach !== "function" || typeof stage !== "function") {
    return { ok: false, error: FILE_UPLOAD_FAIL, status: 502 };
  }

  let applied = false;
  const staged = await stage(classified.files);
  try {
    const attached = await attach(tid);
    try {
      const send = (method, params) => attached.cdp.send(method, params, attached.sessionId);
      if (pending?.backendNodeId) {
        await applyFilesToChooser(send, { backendNodeId: pending.backendNodeId, paths: staged.paths });
      } else if (drop && (drop.x != null || drop.y != null)) {
        await dropFilesOnPage(send, { x: drop.x, y: drop.y, paths: staged.paths });
      } else {
        const nodeId = await findFileInputNode(send);
        if (nodeId) await applyFilesToChooser(send, { nodeId, paths: staged.paths });
        else await dropFilesOnPage(send, { x: 640, y: 400, paths: staged.paths });
      }
      applied = true;
      return { ok: true, kind: "file" };
    } finally {
      await attached.release?.();
    }
  } finally {
    if (applied) scheduleUploadWipe(staged.wipe);
    else await staged.wipe?.();
  }
}
