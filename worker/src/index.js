// Macros AI proxy: keeps the Gemini API key server-side and returns
// calorie + macro estimates as validated JSON.
//
// POST /estimate   body: {"text": "2 Gipfeli"}   header: X-App-Code: <APP_PASSCODE>
// -> 200 {"items":[...],"total":{"kcal","protein","carbs","fat"}}
// -> 4xx/5xx {"error":{"code","message"}}
//
// Config (wrangler.toml [vars] / secrets / .dev.vars):
//   GEMINI_API_KEY   secret, required
//   APP_PASSCODE     secret, optional but recommended for a public app
//   GEMINI_MODEL     comma-separated models, tried in order (defaults to DEFAULT_MODELS)
//   ALLOWED_ORIGINS  comma-separated list of origins allowed to call this

// Free-tier Flash models are often overloaded (503 "high demand") or slow. Flash-Lite
// answered in ~1 s every time in testing, so it goes first; if a model is busy,
// rate-limited, slow or returns junk, the next one is tried within a fixed time budget.
const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash"];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_TEXT = 300;
const ATTEMPT_MS = 8000;  // per model attempt
const TOTAL_MS = 22000;   // whole request (the app waits 30 s)

const SYSTEM_PROMPT = `You estimate calories and macronutrients for a personal calorie tracker used in Switzerland.
The user describes what they ate, in German, Swiss German or English.

Rules:
- If an amount, size or brand is not given, assume a typical Swiss portion and typical products from Swiss retailers (Migros, Coop, Denner) or Swiss bakeries and restaurants.
- Understand Swiss and German food words (e.g. Gipfeli = croissant, Poulet = chicken, Geschnetzeltes, Rüebli = carrots, Birchermüesli, Weggli, Cervelat, Rösti).
- If a branded product is named (e.g. "Coop Schinken-Käse Sandwich"), use its typical label values.
- Split the meal into distinct food items. "amount" is a short description such as "2 pcs (~120 g)" or "300 g". Keep "name" short and in the user's language.
- kcal as integers. protein, carbs and fat in grams, at most one decimal. All values >= 0.
- "total" must equal the sum of all items.
- If the text is not food or drink, return an empty items array and zeros.

Reply with ONLY this JSON and nothing else (no markdown, no comments):
{"items":[{"name":"","amount":"","kcal":0,"protein":0,"carbs":0,"fat":0}],"total":{"kcal":0,"protein":0,"carbs":0,"fat":0}}`;

class EstimateError extends Error {}

/** Remove ``` fences and any prose around the outermost JSON object. */
export function stripFences(text) {
  let t = String(text).trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  return t.trim();
}

function num(v, field) {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 20000) {
    throw new EstimateError(`Invalid number for ${field}`);
  }
  return n;
}
const r1 = (n) => Math.round(n * 10) / 10;

/** Parse and validate the model's reply. Throws EstimateError on anything unexpected. */
export function parseEstimate(text) {
  let data;
  try { data = JSON.parse(stripFences(text)); }
  catch { throw new EstimateError("Model reply is not JSON"); }
  if (!data || typeof data !== "object" || !Array.isArray(data.items)) {
    throw new EstimateError("Model reply has no items array");
  }
  const items = data.items.slice(0, 30).map((it, i) => {
    if (!it || typeof it !== "object") throw new EstimateError(`Item ${i} is not an object`);
    return {
      name: String(it.name ?? "").slice(0, 80),
      amount: String(it.amount ?? "").slice(0, 60),
      kcal: Math.round(num(it.kcal, "kcal")),
      protein: r1(num(it.protein, "protein")),
      carbs: r1(num(it.carbs, "carbs")),
      fat: r1(num(it.fat, "fat")),
    };
  });
  let total;
  if (items.length) {
    total = items.reduce((t, it) => ({
      kcal: t.kcal + it.kcal, protein: t.protein + it.protein, carbs: t.carbs + it.carbs, fat: t.fat + it.fat,
    }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  } else {
    const t = data.total || {};
    total = { kcal: num(t.kcal ?? 0, "kcal"), protein: num(t.protein ?? 0, "protein"), carbs: num(t.carbs ?? 0, "carbs"), fat: num(t.fat ?? 0, "fat") };
  }
  total = { kcal: Math.round(total.kcal), protein: r1(total.protein), carbs: r1(total.carbs), fat: r1(total.fat) };
  return { items, total };
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Code",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(status, body, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(origin ? corsHeaders(origin) : {}), ...extra },
  });
}
const fail = (status, code, message, origin, extra) => json(status, { error: { code, message } }, origin, extra);

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function modelList(env) {
  const list = String(env.GEMINI_MODEL || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS;
}

/** One call to one model. Resolves to {ok:true, estimate} or {ok:false, code, status, retryable}. */
async function tryModel(model, text, env, fetchImpl, timeoutMs) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `What I ate: ${text}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: "low" },
    },
  };
  let res;
  try {
    res = await fetchImpl(GEMINI_BASE + encodeURIComponent(model) + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, code: timeout ? "timeout" : "upstream_unreachable", status: 504, retryable: true };
  }

  if (!res.ok) {
    let detail = {};
    try { detail = (await res.json()).error || {}; } catch {}
    const msg = String(detail.message || "").slice(0, 200);
    if (res.status === 429) return { ok: false, code: "rate_limited", status: 429, retryable: true, msg };
    if (/API_KEY|API key/i.test(JSON.stringify(detail))) return { ok: false, code: "bad_key", status: 502, retryable: false, msg };
    if (res.status === 404) return { ok: false, code: "bad_model", status: 502, retryable: true, msg };
    if (res.status >= 500) return { ok: false, code: "overloaded", status: 503, retryable: true, msg };
    return { ok: false, code: "upstream", status: 502, retryable: false, msg: `Gemini error ${res.status}: ${msg}` };
  }

  let data;
  try { data = await res.json(); } catch { return { ok: false, code: "bad_json", status: 502, retryable: true }; }
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const answer = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!answer) return { ok: false, code: "no_answer", status: 502, retryable: true, msg: (cand && cand.finishReason) || "" };
  try {
    return { ok: true, estimate: parseEstimate(answer) };
  } catch (e) {
    if (e instanceof EstimateError) return { ok: false, code: "bad_json", status: 502, retryable: true };
    throw e;
  }
}

const MESSAGES = {
  rate_limited: "Gemini's free-tier limit was reached. Try again in a minute.",
  overloaded: "Gemini is very busy right now. Try again in a moment.",
  timeout: "Gemini took too long to answer.",
  upstream_unreachable: "Couldn't reach Gemini.",
  bad_key: "Gemini rejected the API key.",
  bad_model: "None of the configured Gemini models are available.",
  bad_json: "The AI's answer couldn't be read. Try again.",
  no_answer: "Gemini returned no answer.",
};

/** Try each model in order (then the first again) until one answers, within TOTAL_MS. */
async function estimate(text, env, fetchImpl) {
  const models = modelList(env);
  const plan = [...models, models[0]];
  const perAttempt = Number(env.ATTEMPT_TIMEOUT_MS) || ATTEMPT_MS;
  const total = Number(env.TOTAL_TIMEOUT_MS) || TOTAL_MS;
  const start = Date.now();
  let last = { ok: false, code: "timeout", status: 504 };
  for (const model of plan) {
    const left = total - (Date.now() - start);
    if (left < Math.min(1000, perAttempt)) break;
    const t0 = Date.now();
    const r = await tryModel(model, text, env, fetchImpl, Math.min(perAttempt, left));
    console.log(JSON.stringify({ ai: model, ok: r.ok, code: r.code, ms: Date.now() - t0, msg: r.msg }));
    if (r.ok) return r;
    last = r;
    if (!r.retryable) break;
  }
  return last;
}

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const okOrigin = origin && allowed.includes(origin) ? origin : null;

  if (origin && !okOrigin) return fail(403, "forbidden_origin", "This origin is not allowed.", null);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: okOrigin ? corsHeaders(okOrigin) : {} });
  if (url.pathname !== "/estimate" && url.pathname !== "/sync") return fail(404, "not_found", "Not found.", okOrigin);

  if (env.APP_PASSCODE && !sameSecret(request.headers.get("X-App-Code") || "", String(env.APP_PASSCODE))) {
    return fail(401, "unauthorized", "Missing or wrong access code.", okOrigin);
  }
  if (url.pathname === "/sync") return handleSync(request, env, okOrigin);
  if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST.", okOrigin);
  if (!env.GEMINI_API_KEY) return fail(500, "not_configured", "GEMINI_API_KEY is not set on the server.", okOrigin);

  let text;
  try { text = String((await request.json()).text ?? "").trim(); }
  catch { return fail(400, "bad_request", "Send JSON like {\"text\": \"2 Gipfeli\"}.", okOrigin); }
  if (!text) return fail(400, "bad_request", "Describe what you ate.", okOrigin);
  if (text.length > MAX_TEXT) return fail(400, "bad_request", `Keep it under ${MAX_TEXT} characters.`, okOrigin);

  const r = await estimate(text, env, fetchImpl);
  if (r.ok) return json(200, r.estimate, okOrigin);
  return fail(r.status, r.code, r.code === "upstream" ? r.msg : (MESSAGES[r.code] || "Gemini error."), okOrigin);
}

// ---------- /sync: one copy of the app data, shared by all your devices ----------
// GET  /sync -> {"state": {...} | null, "version": n}
// PUT  /sync  body {"state": {...}, "baseVersion": n} -> {"version": n+1}
//      409 {"error":{"code":"conflict"}, "version": current} if someone else saved first;
//      the app then pulls, merges and retries, so no device overwrites another.
// Stored gzip-compressed in one D1 row (binding DB). Requires APP_PASSCODE.
const SYNC_MAX_BYTES = 8_000_000;
let tableReady = false;

async function ensureTable(db) {
  if (tableReady) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS store (id TEXT PRIMARY KEY, data BLOB NOT NULL, version INTEGER NOT NULL, updated INTEGER NOT NULL)").run();
  tableReady = true;
}
async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

async function handleSync(request, env, origin) {
  if (!env.APP_PASSCODE) return fail(500, "not_configured", "Set APP_PASSCODE to enable sync.", origin);
  if (!env.DB) return fail(500, "not_configured", "Sync storage (D1 binding DB) is not set up.", origin);
  await ensureTable(env.DB);

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT data, version, updated FROM store WHERE id = 'main'").first();
    if (!row) return json(200, { state: null, version: 0 }, origin, { "Cache-Control": "no-store" });
    return json(200, { state: JSON.parse(await gunzip(row.data)), version: row.version, updated: row.updated }, origin, { "Cache-Control": "no-store" });
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { return fail(400, "bad_request", "Send JSON.", origin); }
    const state = body && body.state;
    const base = body && body.baseVersion;
    if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.days !== "object") {
      return fail(400, "bad_request", "Missing state.", origin);
    }
    if (!Number.isInteger(base) || base < 0) return fail(400, "bad_request", "Missing baseVersion.", origin);
    const text = JSON.stringify(state);
    if (text.length > SYNC_MAX_BYTES) return fail(413, "too_large", "Your data is too large to sync.", origin);
    const data = await gzip(text);
    const now = Date.now();
    const result = base === 0
      ? await env.DB.prepare("INSERT OR IGNORE INTO store (id, data, version, updated) VALUES ('main', ?, 1, ?)").bind(data, now).run()
      : await env.DB.prepare("UPDATE store SET data = ?, version = version + 1, updated = ? WHERE id = 'main' AND version = ?").bind(data, now, base).run();
    if (!result.meta || !result.meta.changes) {
      const row = await env.DB.prepare("SELECT data, version, updated FROM store WHERE id = 'main'").first();
      return json(409, { error: { code: "conflict", message: "Data changed on another device." }, version: row ? row.version : 0 }, origin);
    }
    return json(200, { version: base + 1, updated: now }, origin);
  }

  return fail(405, "method_not_allowed", "Use GET or PUT.", origin);
}

export default {
  // The 4th argument lets tests and the local dev server inject a fetch.
  fetch(request, env, ctx, fetchImpl) {
    return handle(request, env, fetchImpl || fetch);
  },
};
