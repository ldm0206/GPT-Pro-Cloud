import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { turnstileConfig, verifyTurnstile } from "../lib/turnstile.mjs";

const SECRET = "0x4AAAAAAA_secret";
const SITE = "0x4AAAAAAA_site";
const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return handler(opts);
  };
  fn.calls = calls;
  return fn;
}

const okJson = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe("turnstile config", () => {
  it("stays off unless both keys are set", () => {
    assert.equal(turnstileConfig({}).enabled, false);
    assert.equal(turnstileConfig({ TURNSTILE_SITE_KEY: SITE }).enabled, false);
    assert.equal(turnstileConfig({ TURNSTILE_SECRET_KEY: SECRET }).enabled, false);
    const on = turnstileConfig({ TURNSTILE_SITE_KEY: SITE, TURNSTILE_SECRET_KEY: SECRET });
    assert.equal(on.enabled, true);
    assert.equal(on.siteKey, SITE);
    assert.equal(on.secret, SECRET);
    assert.equal(on.verifyUrl, VERIFY);
  });

  it("trims whitespace and lets tests point at a local verifier", () => {
    const on = turnstileConfig({
      TURNSTILE_SITE_KEY: `  ${SITE}\n`,
      TURNSTILE_SECRET_KEY: `\t${SECRET} `,
      TURNSTILE_VERIFY_URL: "http://127.0.0.1:9999/verify",
    });
    assert.equal(on.siteKey, SITE);
    assert.equal(on.secret, SECRET);
    assert.equal(on.verifyUrl, "http://127.0.0.1:9999/verify");
    assert.equal(turnstileConfig({ TURNSTILE_VERIFY_URL: "   " }).verifyUrl, VERIFY);
  });
});

describe("turnstile verify", () => {
  it("never calls out for an empty token", async () => {
    const fetchImpl = fakeFetch(() => okJson({ success: true }));
    const v = await verifyTurnstile({ token: "  ", secret: SECRET, fetchImpl });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "missing-token");
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("accepts a good token and posts the secret, token and ip as a form", async () => {
    const fetchImpl = fakeFetch(() => okJson({ success: true, hostname: "gpc.example.com" }));
    const v = await verifyTurnstile({ token: "tok-1", secret: SECRET, remoteip: "1.2.3.4", fetchImpl });
    assert.deepEqual(v, { ok: true, hostname: "gpc.example.com" });
    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.equal(call.url, VERIFY);
    assert.equal(call.opts.method, "POST");
    assert.equal(call.opts.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(call.opts.body, `secret=${encodeURIComponent(SECRET)}&response=tok-1&remoteip=1.2.3.4`);
    assert.ok(call.opts.signal, "verification must time out");
  });

  it("omits remoteip when the client address is unknown", async () => {
    const fetchImpl = fakeFetch(() => okJson({ success: true }));
    await verifyTurnstile({ token: "tok-1", secret: SECRET, fetchImpl });
    assert.equal(fetchImpl.calls[0].opts.body, `secret=${encodeURIComponent(SECRET)}&response=tok-1`);
  });

  it("rejects a token Cloudflare refuses, keeping its error codes", async () => {
    const fetchImpl = fakeFetch(() => okJson({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    const v = await verifyTurnstile({ token: "tok-1", secret: SECRET, fetchImpl });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "rejected");
    assert.deepEqual(v.errors, ["timeout-or-duplicate"]);
  });

  it("rejects when the verifier is unreachable, times out, or answers garbage", async () => {
    const down = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    assert.deepEqual(await verifyTurnstile({ token: "tok-1", secret: SECRET, fetchImpl: down }), { ok: false, reason: "unreachable" });

    const http500 = fakeFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    assert.deepEqual(await verifyTurnstile({ token: "tok-1", secret: SECRET, fetchImpl: http500 }), { ok: false, reason: "http-500" });

    const html = fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }));
    assert.deepEqual(await verifyTurnstile({ token: "tok-1", secret: SECRET, fetchImpl: html }), { ok: false, reason: "bad-response" });

    const noFlag = fakeFetch(() => okJson({}));
    const v = await verifyTurnstile({ token: "tok-1", secret: SECRET, fetchImpl: noFlag });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "rejected");
    assert.deepEqual(v.errors, []);
  });
});
