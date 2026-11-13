// Run with: node --test worker/test/worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { stripFences, parseEstimate } from "../src/index.js";

const ORIGIN = "https://alessiospeiser-hub.github.io";
const ENV = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-test-flash",
  ALLOWED_ORIGINS: ORIGIN + ",http://localhost:8765",
};

function req(body, { origin = ORIGIN, name = "alessio", method = "POST", path = "/estimate" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (name) headers["X-Sync-Name"] = name;
  return new Request("https://worker.example" + path, {
    method,
    headers,
    body: method === "POST" || method === "PUT" ? JSON.stringify(body) : undefined,
  });
}

function gemini(text, { status = 200, thought } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { code: status, message: "nope", status: "RESOURCE_EXHAUSTED" } }), { status });
    }
    const parts = [];
    if (thought) parts.push({ text: thought, thought: true });
    parts.push({ text });
    return new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }), { status: 200 });
  };
  return { fetchImpl, calls };
}

const GOOD = {
  items: [
    { name: "Gipfeli", amount: "2 pcs (~120 g)", kcal: 460, protein: 9, carbs: 50, fat: 25 },
  ],
  total: { kcal: 460, protein: 9, carbs: 50, fat: 25 },
};

test("stripFences removes markdown fences and surrounding prose", () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFences('Here you go: {"a":1} enjoy'), '{"a":1}');
});

test("parseEstimate validates, coerces and recomputes totals from items", () => {
  const r = parseEstimate(JSON.stringify({
    items: [
      { name: "A", amount: "1", kcal: "100", protein: 10.26, carbs: 5, fat: 2 },
      { name: "B", amount: "1", kcal: 50, protein: 0, carbs: 10, fat: 0 },
    ],
    total: { kcal: 999, protein: 0, carbs: 0, fat: 0 },
  }));
  assert.deepEqual(r.total, { kcal: 150, protein: 10.3, carbs: 15, fat: 2 });
  assert.equal(r.items[0].kcal, 100);
});

test("parseEstimate rejects non-JSON and wrong shapes", () => {
  assert.throws(() => parseEstimate("sorry, I can't"));
  assert.throws(() => parseEstimate('{"items":"x"}'));
  assert.throws(() => parseEstimate('{"items":[{"name":"A","kcal":-5,"protein":0,"carbs":0,"fat":0}]}'));
});

test("happy path: calls Gemini with key header and returns parsed JSON", async () => {
  const g = gemini("```json\n" + JSON.stringify(GOOD) + "\n```", { thought: "thinking..." });
  const res = await worker.fetch(req({ text: "2 Gipfeli" }), ENV, null, g.fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const body = await res.json();
  assert.equal(body.total.kcal, 460);
  assert.equal(g.calls.length, 1);
  assert.match(g.calls[0].url, /\/v1beta\/models\/gemini-test-flash:generateContent$/);
  assert.equal(g.calls[0].init.headers["x-goog-api-key"], "test-key");
  const sent = JSON.parse(g.calls[0].init.body);
  assert.equal(sent.generationConfig.responseMimeType, "application/json");
  assert.match(sent.systemInstruction.parts[0].text, /Swiss/);
  assert.match(sent.contents[0].parts[0].text, /2 Gipfeli/);
});

test("rate limit from Gemini becomes a clear 429", async () => {
  const g = gemini("", { status: 429 });
  const res = await worker.fetch(req({ text: "Apfel" }), ENV, null, g.fetchImpl);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, "rate_limited");
});

test("unreadable model output becomes bad_json, not a crash", async () => {
  const g = gemini("I think it's about 300 calories.");
  const res = await worker.fetch(req({ text: "Apfel" }), ENV, null, g.fetchImpl);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "bad_json");
});

test("AI works without any code or name (open to everyone using the app)", async () => {
  const g = gemini(JSON.stringify(GOOD));
  const res = await worker.fetch(req({ text: "Apfel" }, { name: "" }), { ...ENV, APP_PASSCODE: "old-secret" }, null, g.fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(g.calls.length, 1);
});

test("requests without the app's Origin are rejected (no direct scripting)", async () => {
  const g = gemini(JSON.stringify(GOOD));
  const res = await worker.fetch(req({ text: "Apfel" }, { origin: null }), ENV, null, g.fetchImpl);
  assert.equal(res.status, 403);
  assert.equal(g.calls.length, 0);
});

test("unknown origin is rejected", async () => {
  const g = gemini(JSON.stringify(GOOD));
  const res = await worker.fetch(req({ text: "Apfel" }, { origin: "https://evil.example" }), ENV, null, g.fetchImpl);
  assert.equal(res.status, 403);
  assert.equal(g.calls.length, 0);
});

test("CORS preflight is answered for allowed origins", async () => {
  const res = await worker.fetch(req(null, { method: "OPTIONS" }), ENV, null, gemini("").fetchImpl);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /X-Sync-Name/i);
});

test("empty or too long text is a 400", async () => {
  const g = gemini(JSON.stringify(GOOD));
  assert.equal((await worker.fetch(req({ text: "  " }), ENV, null, g.fetchImpl)).status, 400);
  assert.equal((await worker.fetch(req({ text: "x".repeat(301) }), ENV, null, g.fetchImpl)).status, 400);
});

test("missing API key reports not_configured", async () => {
  const res = await worker.fetch(req({ text: "Apfel" }), { ...ENV, GEMINI_API_KEY: "" }, null, gemini("").fetchImpl);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, "not_configured");
});

// ---------- /sync ----------
function fakeDB() {
  const rows = new Map();
  const db = {
    rows,
    prepare(sql) {
      const stmt = (args) => ({
        bind: (...a) => stmt(a),
        async first() {
          if (!/^SELECT/.test(sql)) return null;
          const r = rows.get(args[0]);
          return r ? { ...r } : null;
        },
        async run() {
          if (/^CREATE/.test(sql)) return { meta: { changes: 0 } };
          if (/^INSERT/.test(sql)) {
            const [id, data, updated] = args;
            if (rows.has(id)) return { meta: { changes: 0 } };
            rows.set(id, { data, version: 1, updated });
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE/.test(sql)) {
            const [data, updated, id, base] = args;
            const r = rows.get(id);
            if (!r || r.version !== base) return { meta: { changes: 0 } };
            rows.set(id, { data, version: r.version + 1, updated });
            return { meta: { changes: 1 } };
          }
          throw new Error("unexpected SQL " + sql);
        },
      });
      return stmt([]);
    },
  };
  return db;
}
function syncReq(method, body, opts = {}) {
  return req(body, { ...opts, method, path: "/sync" });
}
const STATE = { targets: { kcal: 2750, p: 165, f: 70, c: 350 }, days: { "2026-11-13": { entries: [{ id: "x", name: "Gipfeli", kcal: 230, p: 5, f: 12, c: 25, t: 1 }] } }, foods: {} };

test("sync: empty store returns null state at version 0", async () => {
  const env = { ...ENV, DB: fakeDB() };
  const res = await worker.fetch(syncReq("GET"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { state: null, version: 0 });
});

test("sync: PUT then GET round-trips the data (stored compressed)", async () => {
  const env = { ...ENV, DB: fakeDB() };
  const put = await worker.fetch(syncReq("PUT", { state: STATE, baseVersion: 0 }), env);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).version, 1);
  assert.ok(env.DB.rows.get("user:alessio").data instanceof Uint8Array);
  const get = await worker.fetch(syncReq("GET"), env);
  const body = await get.json();
  assert.equal(body.version, 1);
  assert.deepEqual(body.state, STATE);
});

test("sync: stale baseVersion is a 409 conflict, nothing overwritten", async () => {
  const env = { ...ENV, DB: fakeDB() };
  await worker.fetch(syncReq("PUT", { state: STATE, baseVersion: 0 }), env);
  const res = await worker.fetch(syncReq("PUT", { state: { ...STATE, foods: { a: {} } }, baseVersion: 0 }), env);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "conflict");
  assert.equal(env.DB.rows.get("user:alessio").version, 1);
});

test("sync: each name has its own separate data", async () => {
  const env = { ...ENV, DB: fakeDB() };
  await worker.fetch(syncReq("PUT", { state: STATE, baseVersion: 0 }, { name: "alessio" }), env);
  const other = await (await worker.fetch(syncReq("GET", null, { name: "marco" }), env)).json();
  assert.deepEqual(other, { state: null, version: 0 });
  const mine = await (await worker.fetch(syncReq("GET", null, { name: "alessio" }), env)).json();
  assert.deepEqual(mine.state, STATE);
});

test("sync: names ignore case and extra spaces", async () => {
  const env = { ...ENV, DB: fakeDB() };
  await worker.fetch(syncReq("PUT", { state: STATE, baseVersion: 0 }, { name: "Alessio" }), env);
  const res = await (await worker.fetch(syncReq("GET", null, { name: "  ALESSIO " }), env)).json();
  assert.deepEqual(res.state, STATE);
  assert.deepEqual([...env.DB.rows.keys()], ["user:alessio"]);
});

test("sync: a missing or too long name is a 400 name_required", async () => {
  const env = { ...ENV, DB: fakeDB() };
  for (const name of ["", "   ", "x".repeat(41)]) {
    const res = await worker.fetch(syncReq("GET", null, { name }), env);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "name_required");
  }
  assert.equal(env.DB.rows.size, 0);
});

test("sync: invalid body is a 400", async () => {
  const env = { ...ENV, DB: fakeDB() };
  assert.equal((await worker.fetch(syncReq("PUT", { state: "nope", baseVersion: 0 }), env)).status, 400);
  assert.equal((await worker.fetch(syncReq("PUT", { state: STATE }), env)).status, 400);
});

// ---------- model fallback (root cause: primary model returned 503 "high demand" / hung) ----------
function geminiByModel(behaviour) {
  const calls = [];
  const fetchImpl = (url, init) => {
    const model = url.match(/models\/([^:]+):/)[1];
    calls.push(model);
    const b = behaviour[model] || "ok";
    if (b === "hang") {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))));
    }
    if (typeof b === "number") {
      return Promise.resolve(new Response(JSON.stringify({ error: { code: b, status: b === 503 ? "UNAVAILABLE" : "X", message: b === 400 ? "API key not valid. Please pass a valid API key." : "busy" } }), { status: b }));
    }
    return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] }, finishReason: "STOP" }] })));
  };
  return { fetchImpl, calls };
}
const FALLBACK_ENV = { ...ENV, GEMINI_MODEL: "fast-model,backup-model", ATTEMPT_TIMEOUT_MS: "200", TOTAL_TIMEOUT_MS: "2000" };

test("falls back to the next model when the first is overloaded (503)", async () => {
  const g = geminiByModel({ "fast-model": 503 });
  const res = await worker.fetch(req({ text: "2 Gipfeli" }), FALLBACK_ENV, null, g.fetchImpl);
  assert.equal(res.status, 200);
  assert.deepEqual(g.calls, ["fast-model", "backup-model"]);
});

test("falls back when the first model hangs past the per-attempt timeout", async () => {
  const g = geminiByModel({ "fast-model": "hang" });
  const t0 = Date.now();
  const res = await worker.fetch(req({ text: "2 Gipfeli" }), FALLBACK_ENV, null, g.fetchImpl);
  assert.equal(res.status, 200);
  assert.deepEqual(g.calls, ["fast-model", "backup-model"]);
  assert.ok(Date.now() - t0 < 1500);
});

test("when every model is overloaded, says so clearly (503 overloaded)", async () => {
  const g = geminiByModel({ "fast-model": 503, "backup-model": 503 });
  const res = await worker.fetch(req({ text: "2 Gipfeli" }), FALLBACK_ENV, null, g.fetchImpl);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "overloaded");
  assert.ok(g.calls.length >= 2);
});

test("a rejected API key is not retried on other models", async () => {
  const g = geminiByModel({ "fast-model": 400 });
  const res = await worker.fetch(req({ text: "2 Gipfeli" }), FALLBACK_ENV, null, g.fetchImpl);
  assert.equal((await res.json()).error.code, "bad_key");
  assert.deepEqual(g.calls, ["fast-model"]);
});

test("default model order starts with the fast Flash-Lite model", async () => {
  const g = geminiByModel({});
  const env = { ...ENV };
  delete env.GEMINI_MODEL;
  await worker.fetch(req({ text: "Apfel" }), env, null, g.fetchImpl);
  assert.equal(g.calls[0], "gemini-3.5-flash-lite");
});
