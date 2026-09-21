const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 8000;

/**
 * Turnstile 只在两个 key 都填了才算开启：只填一个会让登录页要么不出验证、要么谁也进不来。
 * secret 永远不出网关，前端只拿得到 site key。
 */
export function turnstileConfig(env = process.env) {
  const siteKey = String(env.TURNSTILE_SITE_KEY || "").trim();
  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  return {
    siteKey,
    secret,
    enabled: Boolean(siteKey && secret),
    // 测试可以指向本地假验证端点
    verifyUrl: String(env.TURNSTILE_VERIFY_URL || VERIFY_URL).trim() || VERIFY_URL,
  };
}

/**
 * 拿浏览器提交的 token 去 Cloudflare 换一次校验结果。
 * 校验端点不可达时拒绝（fail closed）：网关本来就要出网访问 ChatGPT，
 * 连不上 challenges.cloudflare.com 说明出口或 CF 本身出了问题，不能当成放行理由。
 */
export async function verifyTurnstile({
  token,
  secret,
  remoteip,
  verifyUrl = VERIFY_URL,
  fetchImpl = fetch,
  timeoutMs = VERIFY_TIMEOUT_MS,
} = {}) {
  const response = String(token || "").trim();
  if (!response) return { ok: false, reason: "missing-token" };
  const form = new URLSearchParams({ secret: String(secret || ""), response });
  if (remoteip) form.set("remoteip", String(remoteip));

  let res;
  try {
    res = await fetchImpl(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "bad-response" };
  }
  if (data?.success !== true) {
    return { ok: false, reason: "rejected", errors: Array.isArray(data?.["error-codes"]) ? data["error-codes"] : [] };
  }
  return { ok: true, hostname: String(data?.hostname || "") };
}
