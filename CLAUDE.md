# Media26 / SMARTER-IPTV — working notes

## Versioning: bump it on EVERY deployment

Any change that ships to users is a new version. Bump both numbers below in the
same commit as the change — never in a follow-up commit, and never skip it
because the change "is small". Two independent mechanisms depend on it, and both
fail silently when it is missed.

| What | Where | How to bump |
|---|---|---|
| App version | `index.html` — `const APP_VERSION='15.5';` | +0.1 (`15.4` → `15.5` → `15.6`) |
| Service-worker cache | `sw.js` — `const CACHE = 'media26-shell-v93';` | +1 (`v92` → `v93`) |

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

`APP_VERSION` is also printed in player error messages (`(v15.5)`), which is how
a user's screenshot tells you which build they are actually running — another
reason it must be truthful.

**Not part of the release bump:** `package.json` `version` and `server.js`
`SERVER_BUILD` track the Render transcoder service. Only touch `SERVER_BUILD`
when `server.js` behaviour changes — but when you do, say so in the summary:
Render is a *separate deploy* from Cloudflare, and a release that changes both
is only half-live until both have gone out. `admin.html` has its own
`ADMIN_VERSION`; keep it equal to `APP_VERSION`.

## Deploying

`.github/workflows/deploy.yml` runs on every push to `main`:

- **cloudflare** — syntax-checks, prints the versions going out, then
  `wrangler deploy` (needs the `CLOUDFLARE_API_TOKEN` secret).
- **render** — POSTs the `RENDER_DEPLOY_HOOK_URL` secret, but *only* when one of
  `server.js`, `package.json`, `package-lock.json`, `Dockerfile`, `render.yaml`
  or `image_482ee8.png` changed. Render cold-starts on every deploy, so an
  app-only release must not trigger it. Add a file to that list in the workflow
  if the service starts being built from it.

Cloudflare's own dashboard Git integration ("Workers Builds") silently stopped
firing once and shipped nothing for five releases with no signal anywhere — if
the live site is behind `main`, check the Actions tab first, not the code.

**Commit message** starts with the new version and a plain-language summary of
what the user gets, e.g.
`v13.9: fill Movies/Series on a live-only playlist, and make playlist channels play in the built-in player`.

## Layout

Single-page app, no build step — the deployed files are the source files.

- `index.html` — the entire app (UI, player engine, M3U/playlist loading).
- `portal.js` — `Media26Portal`: M3U parsing/classification, Stalker/MAG helpers.
- `_worker.js` — Cloudflare Pages Function: `/proxy` CORS relay, `/api/playlist`
  server-side playlist login, `/transcoder/*` pass-through.
- `server.js` — Render service: ffmpeg transcoder + its own `/proxy` relay.
- `sw.js` — network-first service worker for the app shell.
- `mkv.js`, `mpegts.min.js` — in-app Matroska and MPEG-TS engines.
- `m26player2.js` (`M26Player2`, labelled "Player 1" in the UI) — the inbuilt player: probes a
  stream's real bytes and picks a decoder (native/hls.js/mpegts.js/mkv.js) from the evidence.

v19.6 (owner request): the Xtream Codes API (player_api.php — categories, VOD/series info,
account status) was removed entirely. The app is M3U-only now: sign-in always resolves through
the panel's `get.php` playlist endpoint (server URL + username + password, which the app builds
into an M3U URL — labelled "Server Login" in the UI) or a MAC-bound Stalker/MAG line, or a raw
M3U URL/file pasted directly. Do not reintroduce `player_api.php` calls. The `xtream`/`'xtream'`
identifiers that remain (`PROFILE_KINDS.xtream`, server.js `normalizeKind`) are kept only for
backward compatibility with data already stored under that name — they mean "signed in with
username/password", not "uses the Xtream API".

Player choice, app-wide: Player 1 (in-app, `m26player2.js`) is the **only** player — KMPlayer,
VLC, MX Player and the packageless Android "App chooser" were all removed (owner request) and
must not be reintroduced. `PLAYERS` in index.html is the single registry (one entry, `basic`);
there is no per-category player chooser and no external-app handoff any more.

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
