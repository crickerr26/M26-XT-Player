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

## THE MAC / MAG PATH IS LOAD-BEARING. DO NOT TOUCH IT. (owner rule, v19.27)

**Never remove, disable, gate off or "clean up" the MAC and MAG/Stalker connection code.** It is
what makes real customer lines sign in. This was learned the hard way across v19.21-v19.27 on a
live account, and every step of the reasoning that led to breaking it looked sensible at the time.

What is true, and must stay true:

- **A Ministra/Stalker portal is signed in to by the MAG handshake, and nothing else.** Its
  `get.php` returns 404 — there is no M3U endpoint to find. `stalkerHandshake` → `stb.do_auth`
  with the customer's own username and password *is* the sign-in for these lines. A portal URL, a
  login and a password are exactly what such a portal authenticates on.
- **The handshake requires a device MAC.** That is the protocol, not a design choice: `portal.php`
  identifies the box by the `mac=` cookie. The app generates one, keeps it in `localStorage`, and
  it must keep doing so.
- **The MAC is shown, never typed.** There is no MAC input in the sign-in UI and there must not be
  one — a customer is never asked for a MAC they were not given. But the device ID row on the
  "Enter the Portal" sheet (and in Settings) must stay *visible*, with its Copy button: the seller
  pastes that value into the MAC field on the line, and until they do, nothing can work.
- **A login+password line tries the playlist FIRST and the handshake SECOND — both run, both are
  reported** (settled v19.34, after getting this wrong in both directions).
  - Not handshake-first: the playlist is what most lines use.
  - Not playlist-only: on a Ministra portal the handshake is the ONLY thing that works, and
    disabling it for credentials lines (v19.33) broke the very account it was meant to help.
  - The real bug was never the second attempt — it was letting the second attempt's failure
    ERASE the first one's evidence, so a customer saw "Attention Required! | Cloudflare" about
    `portal.php` while the thirteen playlist addresses went unreported. Both verdicts are now
    printed together. Never collapse them again.
  - `_tryMag` fires for a credentials line only on a POSITIVE `stalker-portal` fingerprint, never
    on a vague `no-playlist`/`edge-blocked` guess.
- **`ua=browser` must never carry MAG headers.** The browser fallback exists to get past bot
  protection that refuses the set-top-box identity, so it must send a full browser header set and
  **no `x-user-agent: Model: MAG250`**. That header sat below the if/else for years, went out on
  every request, and made the fallback fail exactly like the attempt it was rescuing. Keep
  `_worker.js` and `server.js` in step on this.

If a MAC-related change seems obviously right, it is the same trap. Ask the owner first.

Player choice, app-wide: Player 1 (in-app, `m26player2.js`) and VLC (external) are the two
players — KMPlayer, MX Player and the packageless Android "App chooser" stay removed (owner
request) and must not be reintroduced; VLC came back by later owner request (v19.8) after being
removed alongside KMPlayer in v19.5. `PLAYERS` in index.html is the single registry (`basic` +
`vlc`); VLC runs on every platform (android/ios/desktop, unlike KMPlayer which had no desktop
target), launches via `androidIntentUrl`/`iosVlcUrl`/`vlcDesktopUrl`, and appears both as a
per-row button (Movies/Series/Live) and a per-category default in Stream Tools for Movies and
Series only — Live TV never defaults to VLC (it drops live channels mid-view), so Live only gets
the row button.

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
