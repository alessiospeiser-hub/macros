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

## Good to know
- **Your data lives only on that device**, inside the installed app. Deleting the home-screen app, or clearing Safari website data, erases it. There's no backup or sync.
- **Updates:** after you upload a new version, open the app twice. The first launch downloads the update in the background, and the second one shows it.
- **Midnight:** each day is stored separately, so a new day starts automatically. Past days are in History.
