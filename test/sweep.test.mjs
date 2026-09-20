import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countSweepLines, createNightlySweeper, sweepCommands, sweepUploadMmin, SWEEP_HOUR } from "../lib/sweep.mjs";
import { UPLOAD_KEEP_MS, DESK_DOWNLOAD_DIR } from "../lib/file-chooser.mjs";
import { deskUploadDirName } from "../lib/desk-files.mjs";

describe("nightly desk sweep", () => {
  it("builds container-local find commands with the upload keep window", () => {
    const { downloads, uploads } = sweepCommands();
    assert.deepEqual(downloads.slice(0, 2), ["sh", "-c"]);
    assert.match(downloads[2], new RegExp(DESK_DOWNLOAD_DIR.replace(/\//g, "\\/")));
    assert.match(downloads[2], /rm -rf/);
    assert.match(uploads[2], /gpc-up-\*/);
    assert.match(uploads[2], new RegExp(`-mmin \\+${sweepUploadMmin()}`));
    assert.equal(sweepUploadMmin() > UPLOAD_KEEP_MS / 60_000, true);
  });

  it("counts the trailing wc -l digit only", () => {
    assert.equal(countSweepLines("3\n"), 3);
    assert.equal(countSweepLines(""), 0);
    assert.equal(countSweepLines("no such dir"), 0);
  });

  it("runs once per local day, inside the 03:00 grace window", async () => {
    const calls = [];
    const sweeps = [];
    let tick = null;
    const sweeper = createNightlySweeper({
      desktopIds: () => ["a", "b"],
      exec: async (id, cmd) => {
        calls.push({ id, cmd: cmd[2] });
        return { output: id === "a" ? "2\n" : "1\n" };
      },
      log: (line) => sweeps.push(line),
      setTimer: (fn) => {
        tick = fn;
        return { unref() {} };
      },
      now: () => new Date("2026-09-21T02:00:00"),
    });
    sweeper.start();
    assert.equal(typeof tick, "function");
    assert.equal(sweeper.needRun(new Date("2026-09-21T02:59:00")), false);
    assert.equal(sweeper.needRun(new Date("2026-09-21T03:00:01")), true);
    const out = await sweeper.run(new Date("2026-09-21T03:00:01"));
    assert.deepEqual(out, { downloadsRemoved: 3, uploadsRemoved: 3 });
    assert.equal(calls.filter((c) => /gpc-downloads/.test(c.cmd)).length, 2);
    assert.equal(calls.filter((c) => /gpc-up-/.test(c.cmd)).length, 2);
    assert.equal(sweeper.needRun(new Date("2026-09-21T03:05:00")), false);
    assert.equal(sweeper.needRun(new Date("2026-09-21T08:30:00")), false);
    assert.equal(sweeper.needRun(new Date("2026-09-22T03:00:00")), true);
    assert.equal(SWEEP_HOUR, 3);
  });

  it("wakes past the hour once a day and skips a dead desk quietly", async () => {
    const seen = [];
    const sweeper = createNightlySweeper({
      desktopIds: () => ["a", "gone"],
      exec: async (id, cmd) => {
        if (id === "gone") throw new Error("docker 404");
        seen.push(id);
        return { output: "0\n" };
      },
      log: () => {},
      setTimer: () => ({ unref() {} }),
      now: () => new Date("2026-09-21T07:30:00"),
    });
    sweeper.start();
    assert.equal(sweeper.needRun(new Date("2026-09-21T07:30:00")), true);
    const out = await sweeper.run(new Date("2026-09-21T07:30:00"));
    assert.deepEqual(out, { downloadsRemoved: 0, uploadsRemoved: 0 });
    assert.deepEqual(seen, ["a", "a"]);
    assert.equal(sweeper.needRun(new Date("2026-09-21T07:40:00")), false);
  });

  it("names fresh upload staging dirs with a timestamp", () => {
    const name = deskUploadDirName(1700000000000);
    assert.match(name, /^gpc-up-1700000000000-[a-z0-9]+$/);
  });
});
