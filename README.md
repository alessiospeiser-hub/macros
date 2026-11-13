# Macros

A simple calorie and macro tracker. It's one HTML file, keeps your data on your device (localStorage), and installs to your iPhone home screen as a full-screen app.

## Files
- `index.html`: the whole app (HTML, CSS, JS)
- `manifest.webmanifest`, `sw.js`, `icons/`: the parts that make it installable and work offline
- `tests/logic.test.mjs`: tests for the calculations (`node --test tests/logic.test.mjs`)
- `docs/`: the design and plan

## Run it locally
The service worker only runs over `http://localhost` or `https://`, so serve the folder instead of double-clicking the file:

```bash
cd "calorie app"
python3 -m http.server 8000
```

Then open http://localhost:8000.

To try it on your phone over Wi-Fi, run `python3 -m http.server 8000 --bind 0.0.0.0` and open `http://<your-mac's-IP>:8000` on the phone. Installing as a full-screen app with offline support needs https, so use one of the hosting options below for that.

## Host it for free

### Option A: Netlify Drop (no account setup, about a minute)
1. Go to https://app.netlify.com/drop
2. Drag the whole `calorie app` folder onto the page.
3. You get an `https://….netlify.app` link. Sign in (free) to keep the site and give it a nicer name.

To update later, drag the folder onto the site's "Deploys" page again.

### Option B: GitHub Pages
1. Create a new public repository on GitHub, e.g. `macros`.
2. Upload the files (`index.html`, `manifest.webmanifest`, `sw.js`, `icons/`) with "Add file → Upload files", or push them with git.
3. In the repo go to Settings → Pages → "Deploy from a branch" → `main` / root → Save.
4. After a minute the app is live at `https://<your-username>.github.io/macros/`.

## Add it to your iPhone home screen
1. Open the https link in **Safari**.
2. Tap the Share button, then **Add to Home Screen**, then **Add**.
3. Launch it from the new icon. It opens full-screen without the Safari bars.

## AI meal logging (Gemini)

Type what you ate in the box at the top of the add page ("2 Gipfeli", "Coop Schinken-Käse Sandwich") and tap ✦. The AI fills in the numbers below. Adjust anything, then tap Save. Saved foods show up as suggestions while you type, and tapping one logs it instantly without calling the AI. The "Yesterday" chips re-log yesterday's meals.

The Gemini API key never goes into the app or GitHub. It lives in a small Cloudflare Worker (`worker/`) that the app calls.

### 1. Get a free Gemini API key
Create one at https://aistudio.google.com/apikey (free tier, no credit card).

### 2. Test locally
```bash
cp worker/.dev.vars.example worker/.dev.vars     # then paste your key into worker/.dev.vars
node worker/dev.mjs                              # AI proxy on http://localhost:8787
python3 -m http.server 8765                      # in a second terminal: the app
```
Open http://localhost:8765, tap +, and type a meal. If you set `APP_PASSCODE` in `.dev.vars`, enter the same code under Settings → AI code.
`worker/.dev.vars` is gitignored. To try the UI without a key, run `MOCK_GEMINI=1 node worker/dev.mjs`.

### 3. Deploy the Worker (free Cloudflare account)
```bash
cd worker
npx wrangler login                        # opens the browser once
npx wrangler secret put GEMINI_API_KEY    # paste the key when asked
npx wrangler secret put APP_PASSCODE      # pick any code, e.g. 6+ characters
npx wrangler deploy                       # prints https://macros-ai.<you>.workers.dev
```
Put that URL plus `/estimate` into `AI_PROD_URL` in `index.html`, push, then enter your code on the phone under Settings → AI code. (Current Worker: https://macros-ai.macros-ai.workers.dev)

### Model and limits
- The models are set in `worker/wrangler.toml` (`GEMINI_MODEL`, currently `gemini-3.5-flash-lite,gemini-3.6-flash`). They're tried in order: if one is busy, slow (8 s per try) or rate-limited, the next one answers. To change them, edit that line and run `npx wrangler deploy`. No app change is needed.
- If Gemini's free limit is reached, the app says so, and you can type the numbers by hand.
- On the free tier, Google may use what you type to improve its products.
- Worker tests: `node --test worker/test/worker.test.mjs`

## Sync across devices
Enter your code under Settings → Code on every device (iPhone, Mac browser, iPad). Your data then lives in your Cloudflare account (D1 database `macros-db`) and stays the same on all of them:
- It syncs when the app opens, about a second after every change, every 30 seconds while open, and when you come back online.
- If two devices change things at the same time, the changes are merged. Entries from both are kept, and a deletion on one device removes the entry everywhere.
- It works offline and catches up later. Settings shows when it last synced.
- Deleting the home-screen app no longer loses anything: add it again, enter the code, and everything comes back.

## Good to know
- **Updates:** after you upload a new version, open the app twice. The first launch downloads the update in the background, and the second one shows it.
- **Midnight:** each day is stored separately, so a new day starts automatically. Past days are in History.
