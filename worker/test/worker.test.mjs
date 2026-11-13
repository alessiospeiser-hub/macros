// Run with: node --test worker/test/worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { stripFences, parseEstimate } from "../src/index.js";

const ORIGIN = "https://alessiospeiser-hub.github.io";
const ENV = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-test-flash",
  APP_PASSCODE: "1234",
  ALLOWED_ORIGINS: ORIGIN + ",http://localhost:8765",
};

function req(body, { origin = ORIGIN, code = "1234", method = "POST", path = "/estimate" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (code) headers["X-App-Code"] = code;
  return new Request("https://worker.example" + path, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
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

test("wrong or missing access code is rejected before calling Gemini", async () => {
  const g = gemini(JSON.stringify(GOOD));
  const res = await worker.fetch(req({ text: "Apfel" }, { code: "0000" }), ENV, null, g.fetchImpl);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "unauthorized");
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
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /X-App-Code/i);
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
