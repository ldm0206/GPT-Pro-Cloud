/**
 * Nightly desk cleanup, 03:00 local.
 * - /config/gpc-downloads: empty outright. The occupant saved their copy (or
 *   let it sit); after-grab deletes already remove one-file-per-save.
 * - /tmp/gpc-up-*: staged upload dirs past the keep window, including ones the
 *   gateway lost track of (restart before the 1h timer fired, failed apply).
 * Runs inside each container via find — the container owns its mtimes, and a
 * foreground exec gives a real exit status and a count. A host asleep at 03:00
 * gets its sweep once it wakes, before the grace window ends.
 */
import { DESK_DOWNLOAD_DIR, UPLOAD_KEEP_MS } from "./file-chooser.mjs";

export const SWEEP_HOUR = 3;
/** Host asleep at 03:00 gets its sweep on a morning start (03:00–11:00). */
export const SWEEP_GRACE_HOURS = 8;
export const SWEEP_POLL_MS = 10 * 60 * 1000;

/** find -mmin for staged upload dirs; never shorter than the live keep window. */
export function sweepUploadMmin(keepMs = UPLOAD_KEEP_MS) {
  return Math.ceil((keepMs + 60_000) / 60_000);
}

export function countSweepLines(output) {
  const m = String(output || "").match(/(\d+)(?![\s\S]*\d)/);
  return m ? Number(m[1]) : 0;
}

export function sweepCommands() {
  return {
    downloads: [
      "sh",
      "-c",
      `find ${DESK_DOWNLOAD_DIR} -mindepth 1 -maxdepth 1 -print -exec rm -rf {} + 2>/dev/null | wc -l`,
    ],
    uploads: [
      "sh",
      "-c",
      `find /tmp -maxdepth 1 -type d -name 'gpc-up-*' -mmin +${sweepUploadMmin()} -print -exec rm -rf {} + 2>/dev/null | wc -l`,
    ],
  };
}

export function createNightlySweeper({
  hour = SWEEP_HOUR,
  graceHours = SWEEP_GRACE_HOURS,
  desktopIds = () => [],
  exec = async () => ({ output: "" }),
  intervalMs = SWEEP_POLL_MS,
  log = (line) => console.log(line),
  now = () => new Date(),
  setTimer = setInterval,
} = {}) {
  let lastDay = "";
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  return {
    async run(date = now()) {
      lastDay = dayKey(date);
      const cmds = sweepCommands();
      let downloadsRemoved = 0;
      let uploadsRemoved = 0;
      for (const id of desktopIds()) {
        try {
          downloadsRemoved += countSweepLines((await exec(id, cmds.downloads, 15_000))?.output);
        } catch {
          /* desk asleep or container gone */
        }
        try {
          uploadsRemoved += countSweepLines((await exec(id, cmds.uploads, 15_000))?.output);
        } catch {
          /* desk asleep or container gone */
        }
      }
      if (downloadsRemoved || uploadsRemoved) {
        log(`sweep: removed downloads=${downloadsRemoved} uploads=${uploadsRemoved}`);
      }
      return { downloadsRemoved, uploadsRemoved };
    },
    needRun(date = now()) {
      if (dayKey(date) === lastDay) return false;
      const h = date.getHours();
      return h >= hour && h < hour + graceHours;
    },
    start() {
      const timer = setTimer(() => {
        const date = now();
        if (!this.needRun(date)) return;
        this.run(date).catch((e) => log(`sweep failed: ${e.message}`));
      }, intervalMs);
      timer?.unref?.();
      return timer;
    },
    lastDay: () => lastDay,
  };
}
