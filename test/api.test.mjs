import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function cookieOf(res) {
  const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return lines
    .map((line) => String(line).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function req(base, path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieOf(res) || cookie || "" };
}

function waitForLog(child, re, ms = 15000) {
  return new Promise((resolve, reject) => {
    const buf = { text: "" };
    const timer = setTimeout(() => reject(new Error(`gateway did not start: ${buf.text}`)), ms);
    const onData = (chunk) => {
      buf.text += chunk.toString();
      if (re.test(buf.text)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(buf.text);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}

describe("presence + kick API", { concurrency: 1 }, () => {
  let child;
  let base;
  let adminCookie;
  let ada;
  let adaCookie;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-api-"));
    const port = 18000 + Math.floor(Math.random() * 2000);
    child = spawn(process.execPath, [join(root, "gateway/server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AUTH_USER: "admin",
        AUTH_PASSWORD: "admin-secret",
        USERS_FILE: join(dir, "users.json"),
        INSTANCES: "a,b",
        DOCKER_SOCKET: join(dir, "no-docker.sock"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLog(child, /gateway on/);
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    }
    base = `http://127.0.0.1:${port}`;
    const login = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret" } });
    assert.equal(login.status, 200);
    adminCookie = login.cookie;
    const created = await req(base, "/api/admin/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "ada", password: "secret6", desks: ["a"] },
    });
    assert.equal(created.status, 200);
    ada = created.data.user;
    const member = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(member.status, 200);
    adaCookie = member.cookie;
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("lets admin see who is on which desk after a member opens it", async () => {
    const open = await req(base, "/api/desks/a/open", { method: "POST", cookie: adaCookie });
    assert.equal(open.status, 200);
    const beat = await req(base, "/api/presence/beat", { method: "POST", cookie: adaCookie, body: { deskId: "a" } });
    assert.equal(beat.status, 200);
    assert.equal(beat.data.viewers.some((v) => v.username === "ada" && v.id === ada.id), true);
    const adminBeat = await req(base, "/api/presence/beat", { method: "POST", cookie: adminCookie, body: { deskId: "b" } });
    assert.equal(adminBeat.status, 200);

    const adminView = await req(base, "/api/presence", { cookie: adminCookie });
    assert.equal(adminView.status, 200);
    const onA = adminView.data.presence.a || [];
    const onB = adminView.data.presence.b || [];
    assert.equal(onA.some((v) => v.id === ada.id && v.username === "ada"), true);
    assert.ok(onB.length);

    const memberView = await req(base, "/api/presence", { cookie: adaCookie });
    assert.equal(memberView.status, 200);
    assert.ok(memberView.data.presence.a);
    assert.equal(memberView.data.presence.b, undefined);
  });

  it("rejects kick from a member and keeps the account after admin kick", async () => {
    const admin = await req(base, "/api/me", { cookie: adminCookie });
    const forbidden = await req(base, `/api/admin/users/${admin.data.user.id}/kick`, { method: "POST", cookie: adaCookie });
    assert.equal(forbidden.status, 403);

    const kicked = await req(base, `/api/admin/users/${ada.id}/kick`, { method: "POST", cookie: adminCookie });
    assert.equal(kicked.status, 200);
    assert.equal(kicked.data.ok, true);
    assert.equal(kicked.data.user.disabled, false);
    assert.equal(kicked.data.user.username, "ada");
    assert.equal((kicked.data.presence.a || []).some((v) => v.id === ada.id), false);

    const dead = await req(base, "/api/me", { cookie: adaCookie });
    assert.equal(dead.status, 401);

    const still = await req(base, "/api/admin/users", { cookie: adminCookie });
    const row = still.data.users.find((u) => u.id === ada.id);
    assert.ok(row);
    assert.equal(row.disabled, false);

    const again = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(again.status, 200);
    assert.equal(again.data.user.disabled, false);

    const missing = await req(base, "/api/admin/users/not-a-user/kick", { method: "POST", cookie: adminCookie });
    assert.equal(missing.status, 404);
  });

  it("refuses to delete a compose seed desk and a missing extra desk", async () => {
    const seed = await req(base, "/api/admin/desks/a", { method: "DELETE", cookie: adminCookie });
    assert.equal(seed.status, 400);
    assert.match(seed.data.error || "", /内置/);
    const ghost = await req(base, "/api/admin/desks/c", { method: "DELETE", cookie: adminCookie });
    assert.equal(ghost.status, 404);
    const ada = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    const forbidden = await req(base, "/api/admin/desks/a", { method: "DELETE", cookie: ada.cookie });
    assert.equal(forbidden.status, 403);
    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.data.desks.find((d) => d.id === "a").extra, false);
  });

  it("defaults CDP off, rejects a second occupant, and rejects page assist", async () => {
    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.desks.find((d) => d.id === "a").cdp, false);
    assert.equal(list.data.desks.find((d) => d.id === "b").cdp, false);

    const ada = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(ada.status, 200);
    const first = await req(base, "/api/desks/a/open", { method: "POST", cookie: ada.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.data.mode, "vnc");

    const created = await req(base, "/api/admin/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "cyd", password: "secret6", desks: ["a"] },
    });
    assert.equal(created.status, 200);
    const cyd = await req(base, "/api/login", { method: "POST", body: { username: "cyd", password: "secret6" } });
    assert.equal(cyd.status, 200);
    const second = await req(base, "/api/desks/a/open", { method: "POST", cookie: cyd.cookie });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "该账号正在使用中");
    assert.equal(second.data.code, "CDP_OFF");

    const share = await req(base, "/api/desks/a/share", { method: "POST", cookie: ada.cookie });
    assert.equal(share.status, 403);
    assert.match(share.data.error || "", /调试口|多人/);
    const onboard = await req(base, "/api/desks/a/onboard", { method: "POST", cookie: ada.cookie });
    assert.equal(onboard.status, 403);
    assert.match(onboard.data.error || "", /调试口|多人/);

    const saved = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: true } });
    assert.equal(saved.status, 400);
    assert.match(saved.data.error || "", /多人分屏暂未开放/);
    const after = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(after.data.desks.find((d) => d.id === "a").cdp, false);
    assert.equal(after.data.desks.find((d) => d.id === "b").cdp, false);

    const off = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: false } });
    assert.equal(off.status, 200);
    assert.equal(off.data.cdp, false);

    const empty = await req(base, "/api/desks/a/files", { method: "POST", cookie: ada.cookie, body: { files: [] } });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.error, "空文件");
    const cancel = await req(base, "/api/desks/a/files", { method: "POST", cookie: ada.cookie, body: { cancel: true } });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.kind, "cancel");
    const pdf = await req(base, "/api/desks/a/files", {
      method: "POST",
      cookie: ada.cookie,
      body: { files: [{ name: "a.pdf", mime: "application/pdf", data: Buffer.from("%PDF").toString("base64") }] },
    });
    assert.ok(pdf.status === 409 || pdf.status === 502);
    assert.doesNotMatch(pdf.data.error || "", /开启多人分屏|有人在使用/);
  });

  it("lets the admin tune the global VNC frame rate and shows it to members", async () => {
    const me = await req(base, "/api/me", { cookie: adminCookie });
    assert.equal(me.data.settings.vncFrameRate, 30);
    // ada was kicked in an earlier test — her old cookie is dead, log in again.
    const relogin = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(relogin.status, 200);
    adaCookie = relogin.cookie;
    const member = await req(base, "/api/me", { cookie: adaCookie });
    assert.equal(member.data.settings.vncFrameRate, 30);

    const saved = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { vncFrameRate: 15 },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.settings.vncFrameRate, 15);
    const memberAfter = await req(base, "/api/me", { cookie: adaCookie });
    assert.equal(memberAfter.data.settings.vncFrameRate, 15);
    const memberView = await req(base, "/api/settings", { cookie: adaCookie });
    assert.equal(memberView.data.settings.vncFrameRate, 15);

    // Live desks pick the change up on the presence beat.
    const beat = await req(base, "/api/presence/beat", {
      method: "POST",
      cookie: adaCookie,
      body: { deskId: "a" },
    });
    assert.equal(beat.status, 200);
    assert.equal(beat.data.settings.vncFrameRate, 15);

    const bad = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { vncFrameRate: 31 },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error || "", /15 \/ 24 \/ 30 \/ 60/);

    const forbidden = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adaCookie,
      body: { vncFrameRate: 60 },
    });
    assert.equal(forbidden.status, 403);

    const back = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { vncFrameRate: 30 },
    });
    assert.equal(back.status, 200);
    assert.equal(back.data.settings.vncFrameRate, 30);
  });
});

describe("CDP lock ignores stored deskCdp=true", { concurrency: 1 }, () => {
  let child;
  let base;
  let adminCookie;
  let usersFile;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-cdp-lock-"));
    usersFile = join(dir, "users.json");
    writeFileSync(
      usersFile,
      JSON.stringify({
        users: [],
        deskCdp: { a: true, b: true },
      }),
    );
    const port = 18000 + Math.floor(Math.random() * 2000);
    child = spawn(process.execPath, [join(root, "gateway/server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AUTH_USER: "admin",
        AUTH_PASSWORD: "admin-secret",
        USERS_FILE: usersFile,
        INSTANCES: "a,b",
        DOCKER_SOCKET: join(dir, "no-docker.sock"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLog(child, /gateway on/);
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    }
    base = `http://127.0.0.1:${port}`;
    const login = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret" } });
    assert.equal(login.status, 200);
    adminCookie = login.cookie;
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("opens exclusive VNC, rejects a second occupant, and rejects enable", async () => {
    const stored = JSON.parse(readFileSync(usersFile, "utf8"));
    assert.equal(stored.deskCdp.a, true);

    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.desks.find((d) => d.id === "a").cdp, false);

    const first = await req(base, "/api/desks/a/open", { method: "POST", cookie: adminCookie });
    assert.equal(first.status, 200);
    assert.equal(first.data.mode, "vnc");

    const created = await req(base, "/api/admin/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "ada", password: "secret6", desks: ["a"] },
    });
    assert.equal(created.status, 200);
    const ada = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(ada.status, 200);
    const second = await req(base, "/api/desks/a/open", { method: "POST", cookie: ada.cookie });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "该账号正在使用中");
    assert.equal(second.data.code, "CDP_OFF");

    const saved = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: true } });
    assert.equal(saved.status, 400);
    assert.match(saved.data.error || "", /多人分屏暂未开放/);
    const after = JSON.parse(readFileSync(usersFile, "utf8"));
    assert.equal(after.deskCdp.a, true);
  });
});

describe("login behind Cloudflare Turnstile", { concurrency: 1 }, () => {
  let child;
  let verifier;
  let base;
  let verifyUrl;
  let answer;

  before(async () => {
    // 本地假验证端点：gateway 通过 TURNSTILE_VERIFY_URL 指向它，不碰真的 Cloudflare
    verifier = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        verifier.seen = { secret: form.get("secret"), response: form.get("response"), remoteip: form.get("remoteip") };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise((r) => verifier.listen(0, "127.0.0.1", r));
    verifyUrl = `http://127.0.0.1:${verifier.address().port}/verify`;

    const dir = mkdtempSync(join(tmpdir(), "gpc-turnstile-"));
    const port = 18000 + Math.floor(Math.random() * 2000);
    child = spawn(process.execPath, [join(root, "gateway/server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AUTH_USER: "admin",
        AUTH_PASSWORD: "admin-secret",
        USERS_FILE: join(dir, "users.json"),
        INSTANCES: "a,b",
        DOCKER_SOCKET: join(dir, "no-docker.sock"),
        TURNSTILE_SITE_KEY: "site-key-123",
        TURNSTILE_SECRET_KEY: "secret-key-456",
        TURNSTILE_VERIFY_URL: verifyUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      // /turnstile on/ 打在 listen 之前，等它会把没起来的网关当成起来了
      const log = await waitForLog(child, /gateway on/);
      assert.match(log, /turnstile on from env \(site key site-key-123\)/);
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    }
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (child && !child.killed) child.kill("SIGTERM");
    await new Promise((r) => verifier.close(r));
  });

  it("hands the login page the site key and never the secret", async () => {
    const setup = await req(base, "/api/setup");
    assert.equal(setup.status, 200);
    assert.equal(setup.data.needed, false);
    assert.equal(setup.data.turnstileSiteKey, "site-key-123");
    const page = await fetch(`${base}/`);
    const csp = page.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
    assert.doesNotMatch(await page.text(), /secret-key-456/);
  });

  it("refuses a password with no token and with a token Cloudflare refuses", async () => {
    answer = { success: true };
    const none = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret" } });
    assert.equal(none.status, 400);
    assert.match(none.data.error || "", /人机验证/);
    assert.equal(verifier.seen, undefined);

    answer = { success: false, "error-codes": ["invalid-input-response"] };
    const bad = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret", turnstileToken: "forged" } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error || "", /人机验证/);
    assert.equal(verifier.seen.secret, "secret-key-456");
    assert.equal(verifier.seen.response, "forged");
    assert.equal(verifier.seen.remoteip, "127.0.0.1");
  });

  it("lets the right password in only after the token checks out", async () => {
    answer = { success: false };
    const wrongPw = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "nope", turnstileToken: "tok" } });
    assert.equal(wrongPw.status, 400);

    answer = { success: true };
    const ok = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret", turnstileToken: "tok" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.username, "admin");
    assert.ok(ok.cookie);

    const me = await req(base, "/api/me", { cookie: ok.cookie });
    assert.equal(me.status, 200);
  });

  it("lets the admin take the keys over from .env, turn them off, and back on", async () => {
    const first = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret", turnstileToken: "tok" } });
    const adminCookie = first.cookie;
    const before = await req(base, "/api/me", { cookie: adminCookie });
    assert.equal(before.data.turnstile.enabled, true);
    assert.equal(before.data.turnstile.siteKey, "site-key-123");
    assert.equal(before.data.turnstile.secretSet, false);
    assert.equal(before.data.turnstile.fromEnv, true);
    assert.equal(before.data.settings.turnstileSecret, undefined);

    // 只填一半会被拒，且不改动已存的值
    const half = await req(base, "/api/admin/settings", { method: "POST", cookie: adminCookie, body: { turnstileSiteKey: "panel-site" } });
    assert.equal(half.status, 400);
    assert.match(half.data.error || "", /一起填/);

    const saved = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { turnstileSiteKey: "panel-site", turnstileSecret: "panel-secret" },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.settings.turnstileSiteKey, "panel-site");
    assert.equal(saved.data.settings.turnstileSecret, undefined);
    assert.deepEqual(saved.data.turnstile, { enabled: true, siteKey: "panel-site", secretSet: true, fromEnv: false });

    // 面板里那对优先：token 要用新密钥去校验
    answer = { success: true };
    verifier.seen = undefined;
    const panelLogin = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret", turnstileToken: "tok" } });
    assert.equal(panelLogin.status, 200);
    assert.equal(verifier.seen.secret, "panel-secret");
    const setup = await req(base, "/api/setup");
    assert.equal(setup.data.turnstileSiteKey, "panel-site");

    // 两个都清空 = 恢复 .env 那一对
    const off = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { turnstileSiteKey: "", turnstileSecret: "" },
    });
    assert.equal(off.status, 200);
    assert.deepEqual(off.data.turnstile, { enabled: true, siteKey: "site-key-123", secretSet: false, fromEnv: true });

    // 密钥栏留空 = 不修改已存密钥
    const keep = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { turnstileSiteKey: "panel-site", turnstileSecret: "panel-secret" },
    });
    assert.equal(keep.status, 200);
    const sameSecret = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { turnstileSiteKey: "panel-site-2" },
    });
    assert.equal(sameSecret.status, 200);
    assert.equal(sameSecret.data.turnstile.siteKey, "panel-site-2");
    answer = { success: true };
    verifier.seen = undefined;
    await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret", turnstileToken: "tok" } });
    assert.equal(verifier.seen.secret, "panel-secret");
  });
});

describe("turnstile configured only in the admin panel", { concurrency: 1 }, () => {
  let child;
  let base;
  let adminCookie;
  let usersFile;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-panel-turnstile-"));
    usersFile = join(dir, "users.json");
    const port = 18000 + Math.floor(Math.random() * 2000);
    child = spawn(process.execPath, [join(root, "gateway/server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AUTH_USER: "admin",
        AUTH_PASSWORD: "admin-secret",
        USERS_FILE: usersFile,
        INSTANCES: "a,b",
        DOCKER_SOCKET: join(dir, "no-docker.sock"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLog(child, /gateway on/);
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    }
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("stays off until the admin saves a pair, then gates login", async () => {
    const setup = await req(base, "/api/setup");
    assert.equal(setup.data.turnstileSiteKey, "");
    const csp = (await fetch(`${base}/`)).headers.get("content-security-policy") || "";
    assert.doesNotMatch(csp, /challenges\.cloudflare\.com/);
    const open = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret" } });
    assert.equal(open.status, 200);
    adminCookie = open.cookie;

    // 没有 secret 时校验端点根本不该被调用 —— 用一个必定失败的可观测端点来证明
    const saved = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { turnstileSiteKey: "panel-site", turnstileSecret: "panel-secret" },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.turnstile.enabled, true);

    const now = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret" } });
    assert.equal(now.status, 400);
    assert.match(now.data.error || "", /人机验证/);
    const setupAfter = await req(base, "/api/setup");
    assert.equal(setupAfter.data.turnstileSiteKey, "panel-site");
    const cspAfter = (await fetch(`${base}/`)).headers.get("content-security-policy") || "";
    assert.match(cspAfter, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);

    // 清空后关掉，登录回到只验密码
    const off = await req(base, "/api/admin/settings", {
      method: "POST",
      cookie: adminCookie,
      body: { turnstileSiteKey: "", turnstileSecret: "" },
    });
    assert.equal(off.status, 200);
    assert.equal(off.data.turnstile.enabled, false);
    const back = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret" } });
    assert.equal(back.status, 200);
    const stored = JSON.parse(readFileSync(usersFile, "utf8"));
    assert.deepEqual(stored.settings.turnstile, { siteKey: "", secret: "" });
  });
});
