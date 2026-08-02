# Media26 / SMARTER-IPTV — working notes

## Versioning: bump it on EVERY deployment

Any change that ships to users is a new version. Bump both numbers below in the
same commit as the change — never in a follow-up commit, and never skip it
because the change "is small". Two independent mechanisms depend on it, and both
fail silently when it is missed.

| What | Where | How to bump |
|---|---|---|
| App version | `index.html` — `const APP_VERSION='14.1';` | +0.1 (`14.0` → `14.1` → `14.2`) |
| Service-worker cache | `sw.js` — `const CACHE = 'media26-shell-v79';` | +1 (`v78` → `v79`) |

**Why each one matters**

- `APP_VERSION` drives the force-update check: an installed home-screen app
  fetches the live `index.html` and matches it against
  `/APP_VERSION='([0-9.]+)'/`. If the deployed number is not greater than the
  one the device already holds, the device concludes it is current and **never
  reloads** — so a stale app keeps running the old bug indefinitely. Keep the
  literal exactly in that form: single quotes, digits and dots only.
- `CACHE` names the service worker's cache bucket. Changing the string is what
  makes `activate` delete the previous bucket. Leave it alone and the old shell
  can be served from cache offline/first-paint.

`APP_VERSION` is also printed in player error messages (`(v14.1)`), which is how
a user's screenshot tells you which build they are actually running — another
reason it must be truthful.

**Not part of the release bump:** `package.json` `version` and `server.js`
`SERVER_BUILD` track the Render transcoder service, which deploys on its own
cycle. Only touch `SERVER_BUILD` when `server.js` behaviour changes.

**Commit message** starts with the new version and a plain-language summary of
what the user gets, e.g.
`v13.9: fill Movies/Series on a live-only playlist, and make playlist channels play in the built-in player`.

## Layout

Single-page app, no build step — the deployed files are the source files.

- `index.html` — the entire app (UI, player engines, Xtream/playlist loading).
- `portal.js` — `Media26Portal`: M3U parsing/classification, Stalker/MAG helpers.
- `_worker.js` — Cloudflare Pages Function: `/proxy` CORS relay, `/api/playlist`
  server-side playlist login, `/transcoder/*` pass-through.
- `server.js` — Render service: ffmpeg transcoder + its own `/proxy` relay.
- `sw.js` — network-first service worker for the app shell.
- `mkv.js`, `mpegts.min.js` — in-app Matroska and MPEG-TS engines.

Keep `_worker.js` and `server.js` in step where they implement the same thing
(both expose `/proxy`, and both must send the player User-Agent upstream).

## Checking work

There is no test suite. Before committing, at minimum:

```
node --check portal.js && node --check _worker.js && node --check server.js
node -e "const fs=require('fs');for(const b of fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g))new Function(b.slice(8,-9));console.log('ok')"
```

`_worker.js` is an ES module — to exercise its functions in Node, strip the
`export default {...}` block and build them with `new Function`.
