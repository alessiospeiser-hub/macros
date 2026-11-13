# Calorie and macro tracker: design

## Intent
A personal, no-friction calorie and macro tracker used mostly on an iPhone. It opens full-screen from the home screen, logs a meal in a few taps, and shows at a glance how much of each daily target is left. There's no account, no cloud, and nothing beyond the core loop of logging, seeing progress, and looking back.

## Goals
- Log a meal in seconds, and re-add a repeat meal in one tap.
- See calories, protein, fat and carbs as "eaten / target" and "left".
- Keep data on the device and survive app restarts (localStorage).
- Installable PWA that opens full-screen on iOS.

## Non-goals
Food database, barcode scanning, login, sync, charts beyond the progress rings, onboarding, and ads.

## Anti-goals
- Clutter, or anything that slows down logging.
- Red "failure" styling for going over a target.

## Constraints
- One `index.html` with inline CSS and vanilla JS, plus `manifest.webmanifest`, `sw.js`, and app icons. No frameworks, no build step, no backend.
- Mobile-first, system font stack, light and dark mode follow the system.

## Approaches considered
- **Single HTML + localStorage + small service worker** (chosen, as specified). It needs zero tooling and can be hosted anywhere static.
- A framework or bundler setup (rejected): you asked for no build step, and the app is too small to benefit.
- IndexedDB instead of localStorage (rejected): the data is tiny (a few KB per month), and localStorage is simpler.

## Decided with you
- **Style:** calm minimal (Apple Health-like). Light gray page, white rounded cards, subtle shadows, thin rings.
- **Palette:** classic fitness. Calories are coral `#FF5A36` (also the accent), protein is blue `#0A84FF`, fat is amber `#FFB020`, carbs are green `#30C26A`.
- **Today layout:** a large hero ring for calories ("1,780 / 2,750", "970 left"), with three small rings for protein, fat and carbs underneath, then today's entries.
- **Add form:** a full-screen page with Cancel / "New entry" / Save at the top. Fields stacked: Name (optional), Calories (optional, placeholder shows the auto value), Protein, Fat, Carbs. Recent foods appear as chips below the fields.
- **Navigation:** a bottom tab bar with Today, a raised coral "+" in the middle, and History.

## My calls (correct anything)
- **Settings:** a gear icon in the Today header opens a small sheet to edit the four targets. Defaults are 2750 kcal, 165 P, 70 F, 350 C.
- **Delete:** swipe an entry left to reveal Delete, or tap an entry to get a Delete action. Each entry also has a short undo toast.
- **Over target:** the ring stays full, the label switches to "N over", and it uses a darker shade of the macro's color, not red.
- **Hit targets:** a day counts as hit when calories are within ±10% of the target and protein is ≥ 100% of target. History shows a green check or a gray dash per day.
- **History:** a list of past days, newest first, showing the date, kcal total, protein total, and the hit marker. Tapping a day opens a read-only view of that day's entries and rings.
- **Quick add:** chips are built from previously saved entries that have a name, de-duplicated by name (the latest macros win) and sorted by how often and how recently they were used. The top ~12 are shown. Tapping a chip adds that entry to today right away and returns to Today. Long-press removes a chip.
- **Calories:** if left empty, calories = P×4 + C×4 + F×9, rounded. Number fields use `inputmode="decimal"` so the numeric keypad opens.
- **Midnight reset:** entries are stored per local date key (`YYYY-MM-DD`). Today is recomputed on open, when the app comes back to the foreground, and on a timer at midnight, so nothing needs to be deleted.
- **Targets per day:** each day stores a snapshot of the targets in effect, so editing targets doesn't rewrite your past hits.
- **Native feel:** safe-area padding for the notch and home bar, no zoom on input focus (16px inputs), no tap-highlight flash, and the status bar color matches the page.
- **Offline:** the service worker caches the app shell (cache-first), so it opens without a connection.

## Left to the builder
Exact spacing and type scale, icon artwork, animation details (kept subtle; respects reduced motion).
