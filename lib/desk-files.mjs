/**
 * Stage user-picked files inside the desk container so Chromium can
 * DOM.setFileInputFiles them. Wipe the token dir afterwards. Never log bytes.
 */
import { randomBytes } from "node:crypto";
import { deskContainerName } from "./docker.mjs";
import { DESK_DOWNLOAD_DIR, safeUploadName, sanitizeDownloadName } from "./file-chooser.mjs";

/** Max bytes of filename inside the staged dir (dir prefix + "/"), ustar cap 100. */
const STAGED_NAME_CAP = 99 - "gpc-up-".length - 12 - 1;

export function uploadToken() {
  return randomBytes(6).toString("hex");
}

export function deskUploadDir(token) {
  return `/tmp/gpc-up-${String(token || "").replace(/[^a-z0-9]/gi, "")}`;
}

/** Upload staging is dated (gpc-up-<ms>-<token>) so the nightly sweep can cross
 *  check mtimes against names from outside the container. */
export function deskUploadDirName(now = Date.now()) {
  return `gpc-up-${now}-${uploadToken()}`;
}

function octalField(n, width) {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/**
 * ustar header names cap at 100 bytes. Node would silently drop a partial
 * multibyte tail, creating the file under a shorter name than staged.paths
 * announces — Chromium then reads ENOENT (ChatGPT blames files.oaiusercontent
 * .com). Truncate ourselves, on a character boundary, and use the same name
 * for the entry and the path handed to DOM.setFileInputFiles.
 */
export function fitTarName(name, maxBytes) {
  let out = "";
  let bytes = 0;
  for (const ch of String(name || "")) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out || "file";
}

/** Minimal ustar. entries: { name, bytes? , directory? } */
export function packUstar(entries) {
  const chunks = [];
  for (const entry of entries || []) {
    const name = fitTarName(String(entry.name || "").replace(/^\/+/, ""), 99);
    if (!name) continue;
    const directory = !!entry.directory;
    const data = directory ? Buffer.alloc(0) : Buffer.from(entry.bytes || []);
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write((directory ? "0000755" : "0000644") + "\0", 100, 8, "latin1");
    header.write("0000000\0", 108, 8, "latin1");
    header.write("0000000\0", 116, 8, "latin1");
    header.write(octalField(data.length, 12), 124, 12, "latin1");
    header.write(octalField(Math.floor(Date.now() / 1000), 12), 136, 12, "latin1");
    header.write("        ", 148, 8, "latin1");
    header.write(directory ? "5" : "0", 156, 1, "latin1");
    header.write("ustar\0", 257, 6, "latin1");
    header.write("00", 263, 2, "latin1");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
    chunks.push(header);
    if (!directory && data.length) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

export async function stageDeskUpload(deskId, files, { docker, containerName } = {}) {
  if (!docker?.putArchive) throw new Error("无法上传文件");
  const token = uploadToken();
  const dirName = deskUploadDirName();
  const container = containerName || deskContainerName(deskId);
  const entries = [{ name: dirName, directory: true }];
  const paths = [];
  for (const f of files || []) {
    const name = fitTarName(safeUploadName(f.name), STAGED_NAME_CAP);
    entries.push({ name: `${dirName}/${name}`, bytes: f.bytes });
    paths.push(`/tmp/${dirName}/${name}`);
  }
  await docker.putArchive(container, "/tmp", packUstar(entries));
  return {
    paths,
    async wipe() {
      try {
        await docker.exec?.(container, ["rm", "-rf", `/tmp/${dirName}`]);
      } catch {
        /* /tmp leftover is better than a hang */
      }
    },
  };
}

/**
 * Chromium fires Browser.downloadWillBegin before the file exists; poll the
 * desk download dir until the size settles. Extensionless or duplicate-name
 * saves fall back to the newest regular file.
 */
export async function resolveDeskDownload(
  name, {
    readdir,
    stat,
    timeoutMs = 12_000,
    pollMs = 400,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  if (typeof readdir !== "function" || typeof stat !== "function") return null;
  const wanted = sanitizeDownloadName(name);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    let entries = [];
    try {
      entries = await readdir(DESK_DOWNLOAD_DIR);
    } catch {
      entries = [];
    }
    const exact = entries.filter((e) => e !== wanted && sanitizeDownloadName(e) === wanted);
    const target = exact[0] || entries.find((e) => e !== wanted) || wanted;
    try {
      const info = await stat(`${DESK_DOWNLOAD_DIR}/${target}`);
      const size = Number(info?.size) || 0;
      if (size > 0 && last && last.name === target && size === last.size) {
        return { name: target, size };
      }
      last = { name: target, size };
    } catch {
      /* not flushed to disk yet */
    }
    await sleep(pollMs);
  }
  return null;
}

function tarString(buf, from, len) {
  return buf.toString("latin1", from, from + len).replace(/\0.*$/, "").trim();
}

/** Dest-wins extraction of the one pulled file. Reads bytes only, never the tar whole. */
export function extractTarEntry(tar, dest) {
  const buf = Buffer.isBuffer(tar) ? tar : Buffer.from(tar || []);
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = tarString(buf, off, 100);
    if (!name) break;
    const size = parseInt(tarString(buf, off + 124, 12) || "0", 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const isFile = type === "0" || type === "";
    if (isFile && !/\//.test(name)) {
      if (name === dest) return buf.subarray(off + 512, off + 512 + size);
    }
    off += 512 + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
  }
  return null;
}
