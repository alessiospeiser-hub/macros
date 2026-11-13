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
//   GEMINI_MODEL     defaults to DEFAULT_MODEL
//   ALLOWED_ORIGINS  comma-separated list of origins allowed to call this

const DEFAULT_MODEL = "gemini-3.8-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_TEXT = 300;
const TIMEOUT_MS = 25000;

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

async function callGemini(text, env, fetchImpl) {
  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: `What I ate: ${text}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: "low" },
    },
  };
  return fetchImpl(GEMINI_BASE + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const okOrigin = origin && allowed.includes(origin) ? origin : null;

  if (origin && !okOrigin) return fail(403, "forbidden_origin", "This origin is not allowed.", null);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: okOrigin ? corsHeaders(okOrigin) : {} });
  if (url.pathname !== "/estimate") return fail(404, "not_found", "Not found.", okOrigin);
  if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST.", okOrigin);

  if (env.APP_PASSCODE && !sameSecret(request.headers.get("X-App-Code") || "", String(env.APP_PASSCODE))) {
    return fail(401, "unauthorized", "Missing or wrong access code.", okOrigin);
  }
  if (!env.GEMINI_API_KEY) return fail(500, "not_configured", "GEMINI_API_KEY is not set on the server.", okOrigin);

  let text;
  try { text = String((await request.json()).text ?? "").trim(); }
  catch { return fail(400, "bad_request", "Send JSON like {\"text\": \"2 Gipfeli\"}.", okOrigin); }
  if (!text) return fail(400, "bad_request", "Describe what you ate.", okOrigin);
  if (text.length > MAX_TEXT) return fail(400, "bad_request", `Keep it under ${MAX_TEXT} characters.`, okOrigin);

  let res;
  try { res = await callGemini(text, env, fetchImpl); }
  catch (e) {
    const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return fail(504, timeout ? "timeout" : "upstream_unreachable", timeout ? "Gemini took too long to answer." : "Couldn't reach Gemini.", okOrigin);
  }

  if (!res.ok) {
    let detail = {};
    try { detail = (await res.json()).error || {}; } catch {}
    if (res.status === 429) {
      const ra = res.headers.get("Retry-After");
      return fail(429, "rate_limited", "Gemini's free-tier limit was reached. Try again in a minute.", okOrigin, ra ? { "Retry-After": ra } : {});
    }
    const badKey = /API_KEY|API key/i.test(JSON.stringify(detail));
    if (badKey) return fail(502, "bad_key", "Gemini rejected the API key.", okOrigin);
    if (res.status === 404) return fail(502, "bad_model", `Model not available: ${env.GEMINI_MODEL || DEFAULT_MODEL}.`, okOrigin);
    return fail(502, "upstream", `Gemini error ${res.status}: ${String(detail.message || "").slice(0, 200)}`, okOrigin);
  }

  let data;
  try { data = await res.json(); } catch { return fail(502, "bad_json", "Gemini returned an unreadable reply.", okOrigin); }
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const answer = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!answer) return fail(502, "no_answer", `Gemini returned no answer (${(cand && cand.finishReason) || "unknown"}).`, okOrigin);

  try {
    return json(200, parseEstimate(answer), okOrigin);
  } catch (e) {
    if (e instanceof EstimateError) return fail(502, "bad_json", "The AI's answer couldn't be read. Try again.", okOrigin);
    throw e;
  }
}

export default {
  // The 4th argument lets tests and the local dev server inject a fetch.
  fetch(request, env, ctx, fetchImpl) {
    return handle(request, env, fetchImpl || fetch);
  },
};
