// Run with: node --test tests/logic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const m = html.match(/<script id="logic">([\s\S]*?)<\/script>/);
assert.ok(m, "index.html must contain <script id=\"logic\">");
const ctx = { window: {} };
vm.runInNewContext(m[1], ctx);
const L = ctx.window.Logic;

test("kcalFromMacros uses 4/9/4", () => {
  assert.equal(L.kcalFromMacros(42, 12, 61), 520);
  assert.equal(L.kcalFromMacros(0, 0, 0), 0);
});

test("parseNum handles decimal comma, blanks and junk", () => {
  assert.equal(L.parseNum("12,5"), 12.5);
  assert.equal(L.parseNum(" 30 "), 30);
  assert.equal(L.parseNum(""), null);
  assert.equal(L.parseNum("abc"), null);
  assert.equal(L.parseNum("-5"), null);
});

test("entryKcal prefers explicit kcal, else derives", () => {
  assert.equal(L.entryKcal({ kcal: 300, p: 10, f: 10, c: 10 }), 300);
  assert.equal(L.entryKcal({ kcal: null, p: 42, f: 12, c: 61 }), 520);
});

test("totals sums entries", () => {
  const t = L.totals([
    { kcal: 520, p: 42, f: 12, c: 61 },
    { kcal: 100, p: 1.5, f: 0, c: 20 },
  ]);
  assert.deepEqual({ ...t }, { kcal: 620, p: 43.5, f: 12, c: 81 });
});

test("isHit: kcal within ±10% and protein >= target", () => {
  const T = { kcal: 2750, p: 165, f: 70, c: 350 };
  assert.equal(L.isHit({ kcal: 2600, p: 165 }, T), true);
  assert.equal(L.isHit({ kcal: 3025, p: 200 }, T), true);
  assert.equal(L.isHit({ kcal: 2400, p: 170 }, T), false);
  assert.equal(L.isHit({ kcal: 2750, p: 160 }, T), false);
});

test("remaining reports left or over", () => {
  assert.deepEqual({ ...L.remaining(80, 70) }, { left: 10, over: true });
  assert.deepEqual({ ...L.remaining(50, 70) }, { left: 20, over: false });
  assert.deepEqual({ ...L.remaining(70, 70) }, { left: 0, over: false });
});

test("dateKey uses local date", () => {
  assert.equal(L.dateKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(L.dateKey(new Date(2026, 11, 31, 0, 1)), "2026-12-31");
});

test("msUntilMidnight", () => {
  assert.equal(L.msUntilMidnight(new Date(2026, 0, 5, 23, 59, 0, 0)), 60000);
});

test("rankFoods sorts by count then recency, caps at 12", () => {
  const foods = {};
  for (let i = 0; i < 15; i++) foods["f" + i] = { name: "F" + i, count: 1, last: i };
  foods.top = { name: "Top", count: 5, last: 0 };
  const r = L.rankFoods(foods);
  assert.equal(r.length, 12);
  assert.equal(r[0].name, "Top");
  assert.equal(r[1].name, "F14");
});
