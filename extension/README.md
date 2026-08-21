# career-ops bridge extension

Unpublished, load-unpacked personal extension. Talks ONLY to `localhost`/`127.0.0.1`
(see `host_permissions` in manifest.json) — it cannot reach any other host.

## Install (dev)

1. Start the career-ops web app: `cd ../web && npm run dev`
2. Chrome → `chrome://extensions` → enable "Developer mode" → "Load unpacked" → select this `extension/` directory.
3. Click the extension icon once → Options → confirm the server URL (default `http://localhost:3000`) and pick a CLI id.
4. On any page, click the small "co" pill at the bottom-right edge to capture + evaluate.

## What it does and doesn't do

- Captures page URL/title/visible text on click. Read-only — never clicks, types, or submits anything on the page you're browsing.
- Sends the capture to your own local career-ops web app's `/api/assistant` — the exact same assistant the web app's chat uses.
- "Evaluate this job" runs natively in the side panel (same `/api/run` call the web app makes). Every other action (apply, generate PDF, change status, research, etc.) opens/focuses a career-ops browser tab so the real web app finishes it — nothing is reimplemented.
