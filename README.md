# Media26 Transcoder (universal playback server)

The Media26 XT Player already plays anything your **device** can decode. This
small companion server is the safety net for the rest — the formats a browser
physically can't handle on its own:

- **HEVC / H.265** on non-Apple browsers (Chrome, Firefox, Android)
- **MKV / AVI** containers
- **AC3 / E-AC3 / DTS** audio tracks
- flaky live **MPEG-TS** streams

It uses FFmpeg to convert those, on the fly, into browser-native **HLS
(H.264 + AAC)** so they play **inside the built-in player** on any device.
Once it's running and its URL is in the app, playback uses it **automatically**
whenever a title can't play natively — you never pick it manually.

---

## 1. Deploy it (one click, no card, ~2 min)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/crickerr26/SMARTER-IPTV)

1. Click the button. Sign in to Render (free) and confirm — it reads
   `render.yaml` and builds the Docker image (FFmpeg included) for you.
2. Wait for the status to go **Live**, then copy the service URL. It looks like
   `https://media26-transcoder-xxxx.onrender.com`.

That's it — no environment variables to fill in. The server figures out its own
HTTPS address, and there's no access token to copy.

> The **free** plan sleeps when idle, so the *first* play after a quiet period
> waits a few seconds for it to wake. For an always-on, snappier server, open the
> service in Render and switch the plan to **Starter**, or run it on any cheap
> VPS with Docker (below).

## 2. Paste the URL into the app (once)

In **Media26 XT Player**: open **Stream Tools** → paste the URL into the
**Transcoder server** field. Done. From now on, if a movie/series/live channel
can't play natively, the app converts it through your server and keeps playing
in the built-in player — no further taps.

> The web app is served over **HTTPS**, so the transcoder must be **HTTPS** too
> (Render and Railway give you that automatically). A plain `http://` VPS URL is
> blocked by the browser as mixed content — put it behind HTTPS.

---

## Other ways to host it

### Railway
Create a new project → **Deploy from GitHub repo** → pick this repo. Railway
detects the `Dockerfile` and deploys it with FFmpeg. Copy the generated
`https://…up.railway.app` URL and paste it into the app.

### Any VPS with Docker
```bash
docker compose up -d --build
# server is on :8080 — put HTTPS (Caddy/Nginx/Cloudflare Tunnel) in front
```
or plain Docker:
```bash
docker build -t media26-transcoder .
docker run -p 8080:8080 -e CORS_ORIGIN='*' media26-transcoder
```

### Run locally (needs FFmpeg installed)
```bash
npm start
curl http://localhost:8080/health   # {"ok":true,...}
```

---

## How the app calls it

```text
GET /health                                  → { ok: true }
GET /hls?profile=vod&url=<ENCODED_STREAM>     → 302 → /sessions/<id>/index.m3u8
GET /hls?profile=live&url=<ENCODED_STREAM>    → 302 → rolling live HLS
```

`profile=live` uses a short rolling playlist for fast startup; `profile=vod`
writes a full playlist so seeking works while FFmpeg converts. If you set an
`ACCESS_TOKEN` env var, add `&token=<TOKEN>` (the app has a token field next to
the URL for this).

## Optional environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8080` | Listen port |
| `CORS_ORIGIN` | `*` | Allowed web origin |
| `PUBLIC_BASE_URL` | *(auto)* | Only needed behind a custom domain |
| `ACCESS_TOKEN` | *(none)* | Lock the transcoder to yourself |
| `SESSION_TTL_MS` | `1800000` | Idle session cleanup (30 min) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | *(none)* | Activation-code store. Both required together to turn on licensing at all — an [Upstash](https://upstash.com) Redis database's REST URL/token (free tier is plenty). Unset = activation and self-serve renewal are both quietly disabled; playback is unaffected either way. |
| `DEVICE_LIMIT` | `2` | Devices a single activation code may run on before it auto-blocks |
| `CALLMEBOT_KEY` / `CALLMEBOT_PHONE` | *(none)* | WhatsApp alert on a device-limit block or a Stripe renewal — [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) one-time opt-in key, and the phone number to message |
| `STRIPE_SECRET_KEY` | *(none)* | Self-serve renewal (§ below). Your Stripe secret key (`sk_live_…` or `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | *(none)* | Signing secret (`whsec_…`) for the webhook endpoint you point at `…/api/stripe-webhook` in the Stripe Dashboard |
| `SUBSCRIPTION_PRICE_CAD_CENTS` | `200` | Price per renewal, in cents (200 = $2.00) |
| `SUBSCRIPTION_CURRENCY` | `cad` | Any [Stripe-supported currency code](https://stripe.com/docs/currencies) |
| `SUBSCRIPTION_DAYS` | `30` | Days one renewal adds to a code's expiry |

### Self-serve subscription renewal (optional)

Lets a customer who already has an activation code (see above) pay to extend it themselves,
instead of asking you every month. It only ever extends a code's expiry — a payment can never
create a new code or a new portal login; that part stays exactly the manual admin.html flow it
always was. Needs both `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (already required for
activation itself) and:

1. In the [Stripe Dashboard](https://dashboard.stripe.com), copy your **secret key** →
   `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint pointing at `https://<this-service>.onrender.com/api/stripe-webhook`,
   listening for at least `checkout.session.completed`. Copy its **signing secret** →
   `STRIPE_WEBHOOK_SECRET`.
3. That's it — no Stripe Product or Price to create by hand, the checkout amount is built from
   `SUBSCRIPTION_PRICE_CAD_CENTS`/`SUBSCRIPTION_CURRENCY` directly. Change those two env vars any
   time to change the price; no redeploy of Stripe-side config needed.

Until both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set, the Renew button simply never
appears in the app — nothing else changes.
