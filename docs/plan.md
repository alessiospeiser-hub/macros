# Calorie tracker implementation plan

> For agentic workers: execute inline (user approved "build it"). Steps use checkboxes.

**Goal:** Build the single-file PWA calorie and macro tracker described in the spec.

**Architecture:** `index.html` holds all markup, CSS and JS. The pure logic (dates, calories, totals, hit check, quick-add ranking) lives in one `<script id="logic">` block that defines `window.Logic`. A Node test extracts and evaluates that block. The UI script renders from a single `state` object saved to localStorage under `cal.v1`.

**Tech stack:** Vanilla HTML/CSS/JS, Web App Manifest, Service Worker, Node (built-in `node:test`) for logic tests.

**Spec:** `docs/design.md`

## Global constraints
- No frameworks, no build step, no backend. Files: `index.html`, `manifest.webmanifest`, `sw.js`, `icons/`.
- Colors: kcal `#FF5A36` (accent), protein `#0A84FF`, fat `#FFB020`, carbs `#30C26A`.
- Default targets: 2750 kcal, 165 P, 70 F, 350 C.
- kcal from macros = round(P×4 + C×4 + F×9).
- Light/dark via `prefers-color-scheme`; system font; inputs ≥16px; safe-area insets.

## Review focus
1. Empty or garbage number input (commas like "12,5", blank everything) → decimal comma parsed; an entry with all values empty or 0 isn't saved.
2. App left open across midnight or resumed next day → Today switches to the new date.
3. Corrupt or missing localStorage → app starts with defaults and doesn't crash.
4. Going over target → ring full, label "N over", no red.
5. Long food names → truncate with ellipsis in the list and chips.

---

### Task 1: Logic module and tests
**Files:** create `index.html` (logic block only at first), `tests/logic.test.mjs`

**Produces (`window.Logic`):**
- `dateKey(d: Date) -> "YYYY-MM-DD"` (local time)
- `parseNum(s: string) -> number|null` (accepts "12,5"; blank → null)
- `kcalFromMacros(p,f,c) -> number`
- `entryKcal({kcal,p,f,c}) -> number` (uses kcal when not null, else derived)
- `totals(entries) -> {kcal,p,f,c}`
- `isHit(totals, targets) -> boolean` (|kcal−T|/T ≤ 0.10 and p ≥ target p)
- `remaining(eaten, target) -> {left:number, over:boolean}`
- `rankFoods(foods: {[nameLower]:{name,kcal,p,f,c,count,last}}) -> array` (sorted by count desc, then last desc, max 12)
- `msUntilMidnight(d: Date) -> number`

- [ ] Write tests: `kcalFromMacros(42,12,61)===520`; `parseNum("12,5")===12.5`; `parseNum("")===null`; `isHit({kcal:2600,p:165},{kcal:2750,p:165})===true`; `isHit({kcal:2400,p:170},…)===false`; `remaining(80,70)` → `{left:10,over:true}`; `dateKey(new Date(2026,0,5))==="2026-01-05"`; rankFoods order and cap of 12.
- [x] Run `node --test tests/logic.test.mjs` → FAIL.
- [x] Implement the logic block.
- [x] Run `node --test tests/logic.test.mjs` → PASS.

### Task 2: App UI (Today, Add page, settings sheet, History, day detail)
**Files:** modify `index.html`
**Consumes:** `Logic.*`
- State: `{targets, days:{[key]:{targets, entries:[{id,name,kcal,p,f,c,t}]}}, foods}`. `load()` / `save()` wrap localStorage in try/catch and fall back to defaults on bad JSON.
- Today: header (date + gear), hero ring, 3 small rings, entry list (swipe-left delete, tap → delete action sheet), undo toast.
- Tab bar: Today · raised "+" · History.
- Add page: Cancel / New entry / Save. Fields: name (text), kcal, P, F, C (`inputmode="decimal"`). The kcal placeholder shows the live auto value. Recent chips below: tap adds the entry immediately; long-press (500 ms) asks to remove.
- Settings sheet: 4 target inputs + Save.
- History: days with entries other than today, newest first, row showing date · kcal · protein · ✓ or –. Tap → day detail (rings + entries, read-only).
- Midnight: re-render on `visibilitychange` and on a `setTimeout(msUntilMidnight)`.
- [ ] Build it, then verify in the browser at 375×812 in light and dark: add via form, add via chip, delete via swipe and tap, undo, edit targets, history row and day detail.

### Task 3: PWA
**Files:** create `manifest.webmanifest`, `sw.js`, `icons/icon-192.png`, `icons/icon-512.png`, `icons/apple-touch-icon.png`
- Manifest: `display: standalone`, `start_url: "./"`, `scope: "./"`, theme colors.
- `index.html` head: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style: default`, `theme-color` meta for light and dark, `viewport-fit=cover`.
- SW: cache-first for the app shell, versioned cache name, old caches deleted on activate.
- [ ] Serve with `python3 -m http.server`, confirm the SW registers and the manifest parses with no console errors.
