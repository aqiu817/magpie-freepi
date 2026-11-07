import test from "node:test"
import assert from "node:assert/strict"

import { FreePiPlugin, _internal } from "../index.mjs"
import {
  BASE,
  SESSION_ID,
  authHeaders,
  calibrateClientVersion,
  clampIntervalMs,
  getClientVersion,
  pollForToken,
  reportImpression,
} from "../lib/upstream.mjs"
import { FALLBACK_MODEL_IDS, MODEL_LIMITS, parseCatalog } from "../lib/catalog.mjs"

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function mockFetch(routes = []) {
  const calls = []
  const fn = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init, headers: Object.fromEntries(new Headers(init?.headers ?? {})) })
    for (const [needle, handler] of routes) if (u.includes(needle)) return handler(u, init)
    return json({ error: { message: "no route" } }, 404)
  }
  fn.calls = calls
  return fn
}

async function withFetch(routes, run) {
  const f = mockFetch(routes)
  const saved = globalThis.fetch
  globalThis.fetch = f
  try {
    return await run(f)
  } finally {
    globalThis.fetch = saved
  }
}

const noop = async () => {}

const SAMPLE_CATALOG = {
  min: "0.6.2",
  latest: "0.6.14",
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · 🔥 Free Unlimited: limited time" },
    { id: "claude-haiku-5.5", name: "Claude Haiku 5.5 · ~2.0x usage" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5 · unavailable", unavailable: true },
    { id: "gpt-6.1-sol-flex", name: "GPT-6.1 Sol Flex · slower · ~41x usage" },
    {
      id: "laguna-s-2.1",
      name: "Laguna S 2.1 (Poolside) · free preview, rate-limited · free, then ~1.8x usage",
    },
    { id: "solar-pro-4", name: "Solar Pro 4 · ~0.6x usage" },
    { nope: true },
  ],
}

test("authHeaders: versioned trio plus conditional bearer", () => {
  const anon = authHeaders(null)
  assert.equal(anon["x-session-id"], SESSION_ID)
  assert.equal(anon["x-client-version"], getClientVersion())
  assert.equal(anon["user-agent"], `free-pi-cli/${getClientVersion()}`)
  assert.ok(!("authorization" in anon))
  const authed = authHeaders("jwt")
  assert.equal(authed.authorization, "Bearer jwt")
})

test("clampIntervalMs: 5s floor, 60s ceiling, invalid -> 5s", () => {
  assert.equal(clampIntervalMs(0), 5_000)
  assert.equal(clampIntervalMs(-3), 5_000)
  assert.equal(clampIntervalMs(2), 5_000)
  assert.equal(clampIntervalMs(120), 60_000)
  assert.equal(clampIntervalMs(15), 15_000)
  assert.equal(clampIntervalMs("7"), 7_000)
})

test("parseCatalog: filters unavailable, extracts rate/free, cleans names", () => {
  const list = parseCatalog(SAMPLE_CATALOG)
  assert.equal(list.length, 5)
  const byId = Object.fromEntries(list.map((m) => [m.id, m]))
  assert.equal(byId["deepseek-v4-flash"].free, true)
  assert.equal(byId["deepseek-v4-flash"].rate, null)
  assert.equal(byId["deepseek-v4-flash"].name, "DeepSeek V4 Flash")
  assert.equal(byId["claude-haiku-5.5"].rate, "2.0")
  assert.equal(byId["claude-haiku-5.5"].free, false)
  assert.equal(byId["gpt-6.1-sol-flex"].rate, "41")
  assert.equal(byId["laguna-s-2.1"].rate, "1.8")
  assert.equal(byId["laguna-s-2.1"].free, false)
  assert.ok(!("claude-sonnet-5.5" in byId))
})

test("parseCatalog: empty and malformed bodies yield empty list", () => {
  assert.deepEqual(parseCatalog(null), [])
  assert.deepEqual(parseCatalog({}), [])
  assert.deepEqual(parseCatalog({ models: "nope" }), [])
})

test("staticModels: one entry per fallback id, models.dev limits where mapped", () => {
  const models = _internal.staticModels()
  assert.equal(Object.keys(models).length, FALLBACK_MODEL_IDS.length)
  assert.deepEqual(models["deepseek-v4-flash"].limit, MODEL_LIMITS["deepseek-v4-flash"])
  assert.equal(models["particle"].limit.context, 128000) // unmapped -> conservative default
  assert.equal(models["deepseek-v4-flash"].tool_call, true)
})

test("config hook declares freepi without clobbering user config", async () => {
  const hooks = await FreePiPlugin({})
  const cfg = { provider: { existing: { name: "Keep" } } }
  await hooks.config(cfg)
  assert.equal(cfg.provider.existing.name, "Keep")
  const p = cfg.provider.freepi
  assert.equal(p.name, "FreePi")
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.api, `${BASE}/v1`)
  assert.equal(Object.keys(p.models).length, FALLBACK_MODEL_IDS.length)
})

test("oauth authorize: consent before polling, then success with saved fields", async () => {
  await withFetch(
    [
      ["/auth/github/device", () => json({ session_id: "s1", verification_uri: "https://github.com/login/device", user_code: "ABCD-1234", interval: 0.05 })],
      ["/auth/consent", () => json({ ok: true })],
      ["/auth/token", () => json({ token: "jwt123" })],
      ["/me", () => json({ user_id: "u1", handle: "a@b.c" })],
    ],
    async (f) => {
      const hooks = await FreePiPlugin({})
      const m = hooks.auth.methods[0]
      const offer = await m.authorize(undefined, {})
      assert.equal(offer.url, "https://github.com/login/device?user_code=ABCD-1234")
      assert.match(offer.instructions, /ABCD-1234/)
      assert.equal(offer.method, "auto")
      const result = await offer.callback(undefined, {})
      assert.deepEqual(result, {
        type: "success",
        refresh: "jwt123", // magpie only persists oauth results carrying refresh
        access: "jwt123",
        expires: 0,
        accountId: "a@b.c",
      })
      const order = f.calls.map((c) => new URL(c.url).pathname)
      assert.ok(order.indexOf("/auth/consent") < order.indexOf("/auth/token"))
    },
  )
})

test("oauth authorize: failed consent short-circuits before polling", async () => {
  await withFetch(
    [
      ["/auth/github/device", () => json({ session_id: "s1", verification_uri: "u", user_code: "C" })],
      ["/auth/consent", () => json({ code: "consent_required" }, 403)],
    ],
    async (f) => {
      const hooks = await FreePiPlugin({})
      const offer = await hooks.auth.methods[0].authorize(undefined, {})
      assert.equal(offer.type, "failed")
      assert.match(offer.error, /consent_required/)
      assert.ok(!f.calls.some((c) => c.url.includes("/auth/token")))
    },
  )
})

test("oauth authorize: unreachable upstream reports failure", async () => {
  await withFetch([], async () => {
    const hooks = await FreePiPlugin({})
    const offer = await hooks.auth.methods[0].authorize(undefined, {})
    assert.equal(offer.type, "failed")
    assert.match(offer.error, /无法连接/)
  })
})

test("pollForToken: aborted signal exits with failed", async () => {
  const c = new AbortController()
  c.abort()
  const r = await pollForToken("s1", { signal: c.signal, sleepImpl: noop })
  assert.equal(r.type, "failed")
  assert.match(r.error, /取消/)
})

test("pollForToken: retry_after clamps the poll interval", async () => {
  let polls = 0
  const r = await pollForToken("s1", {
    timeoutMs: 50,
    sleepImpl: noop,
    fetchImpl: async () => {
      polls++
      return json({ retry_after: 120 })
    },
  })
  assert.equal(r.type, "failed")
  assert.match(r.error, /超时/)
  assert.ok(polls > 1)
})

test("pollForToken: returns token on 200", async () => {
  const r = await pollForToken("s1", {
    sleepImpl: noop,
    fetchImpl: async () => json({ token: "t1", retry_after: 3 }),
  })
  assert.equal(r.type, "success")
  assert.equal(r.token, "t1")
})

test("reportImpression: full flow reports once with the right payload", async () => {
  await withFetch(
    [
      ["/ads/next", () => json({ ad_id: "a1", click_token: "ct", imp_url: `${BASE}/imp/px` })],
      ["/ads/impression", () => json({ ok: true })],
    ],
    async (f) => {
      const n = await reportImpression("jwt")
      assert.equal(n, 1)
      const next = f.calls.find((c) => c.url.includes("/ads/next"))
      assert.equal(next.headers.authorization, "Bearer jwt")
      assert.equal(next.headers["x-session-id"], SESSION_ID)
      const imp = f.calls.find((c) => c.url.includes("/ads/impression"))
      assert.deepEqual(JSON.parse(imp.init.body), { ad_id: "a1", click_token: "ct", imp_fired: true })
      assert.ok(f.calls.some((c) => c.url.includes("/imp/px")))
    },
  )
})

test("reportImpression: no ad or transport error both yield 0 without throwing", async () => {
  const a = await reportImpression("jwt", {
    fetchImpl: async () => json({ ad_id: null }),
  })
  assert.equal(a, 0)
  const b = await reportImpression("jwt", {
    fetchImpl: async () => {
      throw new Error("down")
    },
  })
  assert.equal(b, 0)
})

test("loader.fetch (oauth): injects the header quartet and fires an impression", async () => {
  await withFetch(
    [
      ["/v1/chat/completions", () => json({ ok: true })],
      ["/ads/next", () => json({ ad_id: "a1", click_token: "ct" })],
      ["/ads/impression", () => json({ ok: true })],
    ],
    async (f) => {
      const hooks = await FreePiPlugin({})
      const { fetch: wrapped } = await hooks.auth.loader(async () => ({ type: "oauth", access: "jwt" }))
      const res = await wrapped(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
      })
      assert.equal(res.status, 200)
      const chat = f.calls.find((c) => c.url.includes("/v1/chat/completions"))
      assert.equal(chat.headers.authorization, "Bearer jwt")
      assert.equal(chat.headers["x-session-id"], SESSION_ID)
      assert.equal(chat.headers["x-client-version"], getClientVersion())
      assert.equal(chat.headers["user-agent"], `free-pi-cli/${getClientVersion()}`)
      assert.equal(chat.init.body, JSON.stringify({ model: "deepseek-v4-flash", messages: [] }))
      await new Promise((r) => setTimeout(r, 20))
      assert.ok(f.calls.some((c) => c.url.includes("/ads/impression")))
    },
  )
})

test("loader.fetch (legacy api account): no bearer, no impression", async () => {
  await withFetch([["/v1/chat/completions", () => json({ ok: true })]], async (f) => {
    const hooks = await FreePiPlugin({})
    const { fetch: wrapped } = await hooks.auth.loader(async () => ({ type: "api", key: "trial" }))
    await wrapped(`${BASE}/v1/chat/completions`, { method: "POST", body: "{}" })
    const chat = f.calls.find((c) => c.url.includes("/v1/chat/completions"))
    assert.ok(!("authorization" in chat.headers))
    assert.equal(chat.headers["x-client-version"], getClientVersion())
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(!f.calls.some((c) => c.url.includes("/ads/next")))
  })
})

test("loader.fetch (options.direct): requests bypass the proxy chain", async () => {
  await withFetch(
    [
      ["/v1/chat/completions", () => json({ ok: true })],
      ["/ads/next", () => json({ ad_id: "a1", click_token: "ct" })],
      ["/ads/impression", () => json({ ok: true })],
    ],
    async (f) => {
      const hooks = await FreePiPlugin({ magpie: { options: { direct: true } } })
      const { fetch: wrapped } = await hooks.auth.loader(async () => ({ type: "oauth", access: "jwt" }))
      await wrapped(`${BASE}/v1/chat/completions`, { method: "POST", body: "{}" })
      const chat = f.calls.find((c) => c.url.includes("/v1/chat/completions"))
      assert.equal(chat.init.proxy, false)
      await new Promise((r) => setTimeout(r, 20))
      const ads = f.calls.find((c) => c.url.includes("/ads/next"))
      assert.equal(ads.init.proxy, false)
    },
  )
})

test("usage (oauth): /me supplies account, daily window, lane; 401 flags re-login", async () => {
  const ME = {
    user_id: "u1",
    handle: "ada",
    tier: "young",
    allowance_credits: 100,
    remaining_credits_today: 37,
    refill_at: "2026-11-08T00:00:00Z",
    lane: "fallback",
  }
  await withFetch([["/me", () => json(ME)]], async () => {
    const hooks = await FreePiPlugin({})
    const u = await hooks.auth.usage(async () => ({ type: "oauth", access: "jwt" }))
    assert.equal(u.plan, "Free")
    assert.equal(u.user, "ada")
    const daily = u.windows.find((w) => w.name === "每日额度")
    assert.deepEqual(
      { used: daily.used, amount: daily.amount, limit: daily.limit, unit: daily.unit, resetsAt: daily.resetsAt },
      { used: 63, amount: 63, limit: 100, unit: "credits", resetsAt: ME.refill_at },
    )
    const lane = u.windows.find((w) => w.name === "车道")
    assert.equal(lane.aside, true)
    assert.match(lane.display, /慢车道/)
  })
  await withFetch([["/me", () => json({ user_id: "u2", handle: "no-meter", lane: "standard" })]], async () => {
    const hooks = await FreePiPlugin({})
    const u = await hooks.auth.usage(async () => ({ type: "oauth", access: "jwt" }))
    assert.equal(u.user, "no-meter")
    assert.equal(u.windows.find((w) => w.name === "每日额度"), undefined)
    assert.equal(u.windows.find((w) => w.name === "车道"), undefined)
  })
  await withFetch([["/me", () => json({ message: "bad token" }, 401)]], async () => {
    const hooks = await FreePiPlugin({})
    const u = await hooks.auth.usage(async () => ({ type: "oauth", access: "jwt" }))
    assert.match(u.error, /重新登录/)
  })
})

test("dailyWindow: USD fallback, overflow, and missing meter", () => {
  const usd = _internal.dailyWindow({ cap_usd_today: 0.5, remaining_usd_today: 0.25, refill_at: "t2" })
  assert.deepEqual(
    { used: usd.used, amount: usd.amount, limit: usd.limit, unit: usd.unit, resetsAt: usd.resetsAt },
    { used: 50, amount: 0.25, limit: 0.5, unit: "USD", resetsAt: "t2" },
  )
  const over = _internal.dailyWindow({ allowance_credits: 10, remaining_credits_today: 0 })
  assert.equal(over.used, 100)
  const negative = _internal.dailyWindow({ allowance_credits: 10, remaining_credits_today: -2 })
  assert.equal(negative.used, 120) // overflow past 100 is allowed, never below 0
  assert.equal(_internal.dailyWindow({ cap_usd_today: 0, remaining_usd_today: 0 }), null)
  assert.equal(_internal.dailyWindow({}), null)
  assert.equal(_internal.dailyWindow(null), null)
})

test("usage: ad counter surfaces as an aside window unless disabled", async () => {
  await withFetch(
    [
      ["/v1/x", () => json({ ok: true })],
      ["/ads/next", () => json({ ad_id: "a1", click_token: "ct" })],
      ["/ads/impression", () => json({ ok: true })],
    ],
    async () => {
      const hooks = await FreePiPlugin({})
      const { fetch: wrapped } = await hooks.auth.loader(async () => ({ type: "oauth", access: "jwt" }))
      await wrapped(`${BASE}/v1/x`, { method: "POST", body: "{}" })
      await new Promise((r) => setTimeout(r, 20))
      const u = await hooks.auth.usage(async () => ({ type: "oauth", access: "jwt" }))
      assert.equal(u.windows.length, 1)
      assert.equal(u.windows[0].aside, true)
      assert.match(u.windows[0].display, /1 条/)

      const hooks2 = await FreePiPlugin({ magpie: { options: { adCount: false } } })
      const { fetch: wrapped2 } = await hooks2.auth.loader(async () => ({ type: "oauth", access: "jwt" }))
      await wrapped2(`${BASE}/v1/x`, { method: "POST", body: "{}" })
      await new Promise((r) => setTimeout(r, 20))
      const u2 = await hooks2.auth.usage(async () => ({ type: "oauth", access: "jwt" }))
      assert.equal(u2.windows.length, 0)
    },
  )
})

test("provider.models: live catalog maps rate/free; failure keeps magpie's list", async () => {
  // magpie-built models carry an api object; each entry must keep its own api.id
  const withApi = Object.fromEntries(
    Object.entries(_internal.staticModels()).map(([id, m]) => [
      id,
      { ...m, api: { id, url: `${BASE}/v1`, npm: "@ai-sdk/openai-compatible" } },
    ]),
  )
  await withFetch([["/client-version", () => json(SAMPLE_CATALOG)]], async () => {
    const hooks = await FreePiPlugin({})
    const out = await hooks.provider.models({ models: withApi }, { auth: { type: "oauth", access: "jwt" } })
    assert.ok(!("claude-sonnet-5.5" in out))
    assert.equal(out["claude-haiku-5.5"].rate, 2)
    assert.equal(out["deepseek-v4-flash"].free, true)
    assert.equal(out["claude-haiku-5.5"].api.id, "claude-haiku-5.5") // not the base model's
    assert.equal(out["solar-pro-4"].limit.context, 524288) // per-model limit, not the base's
    assert.equal(out["solar-pro-4"].tool_call, true)
  })
  await withFetch([], async () => {
    const hooks = await FreePiPlugin({})
    const keep = { models: { a: { id: "a" } } }
    const out = await hooks.provider.models(keep, { auth: { type: "oauth", access: "jwt" } })
    assert.equal(out, keep.models)
  })
  const boom = mockFetch([])
  boom.calls = []
  await withFetch([["/client-version", () => { throw new Error("down") }]], async () => {
    const hooks = await FreePiPlugin({})
    const keep = { models: { a: { id: "a" } } }
    const out = await hooks.provider.models(keep, { auth: { type: "oauth", access: "jwt" } })
    assert.equal(out, keep.models)
  })
})

// Keep last: mutates the module-level client-version pin.
test("calibrateClientVersion: numeric compare, garbage ignored, never downgrades", () => {
  assert.equal(calibrateClientVersion({ min: "0.10.0" }), "0.10.0")
  assert.equal(calibrateClientVersion({ latest: "0.6.15" }), "0.10.0")
  assert.equal(calibrateClientVersion({ min: "nope" }), "0.10.0") // NaN compares falsy: ignored
  assert.equal(calibrateClientVersion({ latest: "0.11.0-beta" }), "0.11.0-beta")
  assert.equal(getClientVersion(), "0.11.0-beta")
})
