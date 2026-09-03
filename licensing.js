/* ── THE ACTIVATION STORE, INSIDE THE WORKER (v24.62) ──────────────────────────────────────────
   WHY THIS EXISTS. Activation codes lived only in Upstash Redis, reached from server.js on the
   container host. server.js switches its ENTIRE /api/* surface off when UPSTASH_REDIS_REST_URL and
   UPSTASH_REDIS_REST_TOKEN are unset — every route answers 503 — and on the live deployment they
   have never been set. So "activate the code the customer gave me" could not work, and no amount
   of retyping the code was ever going to change that: the failure was two environment variables
   nobody had filled in, on a host that had itself moved (Render -> Railway) since the docs were
   written.

   Asking the owner to go and set them is a fix that has to be done again on every new host, and
   stays broken in the meantime while customers wait. So the store moves to the one piece of this
   system that is always up, always deployed from this repo, and needs no configuration at all: the
   Worker. A SQLite-backed Durable Object is created by `wrangler deploy` itself from the migration
   in wrangler.jsonc — there is no dashboard step, no namespace to create by hand, no API key, and
   no card. It is available on the Workers Free plan.

   WHAT THIS CHANGES FOR A CUSTOMER: nothing. Same URLs, same request bodies, same response shapes
   as server.js's routes — this file is written against those responses deliberately, because the
   app and admin.html are already built to them and neither should need to know where the record
   is kept. It also removes the free container's cold start from the sign-in path: an activation
   poll is now answered at the edge instead of waking a sleeping service.

   WHAT STILL GOES TO THE CONTAINER: /api/checkout and /api/stripe-webhook. Those need Stripe's
   secret keys, which only the container has, and they are already inert without them.

   IMPORT ON FIRST USE: if a store ever DID exist upstream, its records are pulled in once (see
   importOnce) so nobody who was working yesterday has to be re-activated. Best-effort by design —
   when upstream has no store, which is the case today, there is simply nothing to import.

   All of it lives in ONE Durable Object instance ('v1'). That is deliberate: a Durable Object is
   single-threaded, so allocating a guaranteed-unique code is a plain read-then-write with no race,
   which is exactly the property the "no two customers get the same code" rule needs. */

const DEVICE_LIMIT_DEFAULT = 2;

/* ── Identity, kinds and validation ─────────────────────────────────────────────────────────────
   Ported from server.js verbatim in behaviour. Every value that normalized to something there must
   normalize to exactly the same thing here, or a record written by one and read by the other stops
   matching — see the v13.0/v19.63 notes in server.js for why 'm3u' and 'm3uurl' are distinct. */
export function normalizeCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const hex = s.replace(/[:\-\s]/g, '');
  if (/^[0-9a-fA-F]{12}$/.test(hex) && (/[:\-]/.test(s) || /[a-fA-F]/.test(hex))) {
    return hex.toUpperCase().match(/.{2}/g).join(':');
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 8) return digits;
  return null;
}
function normalizeLoginCode(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length === 6 ? digits : null;
}
export function normalizeKind(raw, user) {
  const k = String(raw || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (k === 'm3uurl' || k === 'm3ulink' || k === 'playlist') return 'm3uurl';
  if (k === 'm3u' || k === 'mac' || k === 'stalker' || k === 'mag') return 'm3u';
  if (k === 'xtream' || k === 'xtreme') return 'xtream';
  return String(user || '').trim() ? 'xtream' : 'm3u';
}
export function validateLine(url, user, kind) {
  const u = String(url || '').trim();
  if (!u) return 'Portal URL is required.';
  if (kind !== 'm3u' && kind !== 'm3uurl' && !String(user || '').trim()) {
    return 'Username is required for a username/password line. For a MAC-only line choose that type — it signs in by MAC and has no username.';
  }
  if (kind === 'm3uurl' && !/^https?:\/\//i.test(u)) {
    return 'An M3U playlist line needs the full playlist link, starting with http:// or https://.';
  }
  return '';
}
/* iptvExpiresAt is the admin's own product; appExpiresAt is the customer's $2 Stripe subscription.
   0 means "no limit" on the first and "never paid, so not required" on the second — and a record
   written before the two were split carries only the legacy `expiresAt`, which was always the
   IPTV side. See the v23.9 note in server.js. */
function iptvExpiryOf(lic) { return (lic && lic.iptvExpiresAt != null) ? lic.iptvExpiresAt : ((lic && lic.expiresAt) || 0); }
function appExpiryOf(lic) { return (lic && lic.appExpiresAt) || 0; }

function randomDigits8() {
  /* 10000000-99999999, so a code never has a leading zero to lose in transit. */
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(10000000 + (b[0] % 90000000));
}
function randomDigits6() {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(100000 + (b[0] % 900000));
}
function randomLocalMac() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  b[0] = (b[0] & 0xfe) | 0x02;   /* locally administered, never a real vendor OUI */
  return Array.from(b).map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}
const jres = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

/* The licensing paths this Worker answers itself. Everything else under /api/ is passed to the
   container untouched — Stripe's two routes need secrets only it holds. */
const LOCAL_PATHS = new Set([
  '/api/newcode', '/api/newmac', '/api/request', '/api/activate', '/api/devices/reset',
  '/api/admin/activate', '/api/admin/create', '/api/admin/update', '/api/admin/list'
]);
export function isLicensingPath(p) { return LOCAL_PATHS.has(p); }

export class LicenseStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    /* Created on first touch rather than in a migration step: a Durable Object's constructor runs
       before every request to it, and CREATE TABLE IF NOT EXISTS is cheap and idempotent. */
    this.sql.exec('CREATE TABLE IF NOT EXISTS lic (code TEXT PRIMARY KEY, json TEXT NOT NULL, created INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  }

  get(code) {
    const rows = this.sql.exec('SELECT json FROM lic WHERE code = ?', code).toArray();
    if (!rows.length) return null;
    try { return JSON.parse(rows[0].json); } catch (e) { return null; }
  }
  findByLoginCode(loginCode) {
    if (!loginCode) return null;
    return this.all().find(x => normalizeLoginCode(x && x.loginCode) === loginCode) || null;
  }
  put(code, obj) {
    this.sql.exec('INSERT INTO lic (code, json, created) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET json = excluded.json',
      code, JSON.stringify(obj), Number(obj && obj.createdAt) || Date.now());
  }
  del(code) { this.sql.exec('DELETE FROM lic WHERE code = ?', code); }
  all() {
    return this.sql.exec('SELECT json FROM lic ORDER BY created DESC').toArray()
      .map(r => { try { return JSON.parse(r.json); } catch (e) { return null; } })
      .filter(Boolean);
  }
  count() { return Number(this.sql.exec('SELECT COUNT(*) AS n FROM lic').toArray()[0].n) || 0; }
  metaGet(k) {
    const rows = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray();
    return rows.length ? rows[0].v : '';
  }
  metaSet(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); }

  get deviceLimit() { return Number(this.env && this.env.DEVICE_LIMIT) || DEVICE_LIMIT_DEFAULT; }

  /* A code nobody else holds. Single-threaded object, so "check then write" cannot race another
     request the way it could against a shared Redis. */
  freshCode(make) {
    for (let i = 0; i < 24; i++) {
      const c = make();
      if (!this.get(c)) return c;
    }
    return '';
  }
  freshLoginCode() {
    for (let i = 0; i < 40; i++) {
      const c = randomDigits6();
      if (!this.findByLoginCode(c)) return c;
    }
    return '';
  }

  /* One-shot pull of any records a previously-configured upstream store still holds, so switching
     the store's home does not strand customers who were already activated. Runs at most once, only
     while this object is empty, and never blocks the request that triggered it for long: if the
     container is asleep, 503ing (its state today) or simply has nothing, we carry on empty. */
  async importOnce(upstreamOrigin) {
    if (this.metaGet('imported') === '1') return;
    if (this.count() > 0) { this.metaSet('imported', '1'); return; }
    if (!upstreamOrigin) return;
    try {
      const r = await fetch(upstreamOrigin + '/api/admin/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) return;                       /* 503 = upstream has no store either; try again later */
      const j = await r.json().catch(() => null);
      const codes = (j && Array.isArray(j.codes)) ? j.codes : null;
      if (!codes) return;
      for (const rec of codes) {
        const code = normalizeCode(rec && rec.code);
        if (!code || this.get(code)) continue;
        /* /api/admin/list reports `devices` as a COUNT, not the list. The identifiers themselves
           are not recoverable from it, so an imported record starts with an empty device list —
           the customer's own device re-registers on its next poll. Deliberately generous: the
           alternative is a device count that can never be reached and a line that blocks itself. */
        this.put(code, Object.assign({}, rec, { devices: [] }));
      }
      this.metaSet('imported', '1');
    } catch (e) { /* nothing importable — a fresh store is the correct outcome */ }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    let body = {};
    if (request.method === 'POST') { try { body = await request.json(); } catch (e) { body = {}; } }
    const upstream = request.headers.get('x-upstream-origin') || '';
    await this.importOnce(upstream);
    const LIMIT = this.deviceLimit;

    /* ── CUSTOMER: allocate a brand-new, unique 8-digit code bound to this device ── */
    if (path === '/api/newcode' || path === '/api/newmac') {
      const deviceId = String(body.deviceId || '').trim().slice(0, 80);
      if (!deviceId) return jres(400, { error: 'Device is required.' });
      const code = this.freshCode(path === '/api/newmac' ? randomLocalMac : randomDigits8);
      if (!code) return jres(500, { error: 'Could not allocate a code, try again.' });
      this.put(code, { code, status: 'pending', devices: [deviceId], createdAt: Date.now() });
      return jres(200, { ok: true, code });
    }

    /* ── CUSTOMER: register a code the device generated itself as pending ── */
    if (path === '/api/request') {
      const code = normalizeCode(body.code);
      const deviceId = String(body.deviceId || '').trim().slice(0, 80);
      if (!code || !deviceId) return jres(400, { error: 'A valid 8-digit code (or MAC address) and device are required.' });
      let lic = this.get(code);
      if (!lic) {
        lic = { code, status: 'pending', devices: [deviceId], createdAt: Date.now() };
        this.put(code, lic);
      } else if (lic.status === 'pending' && (lic.devices || []).indexOf(deviceId) < 0 && (lic.devices || []).length < LIMIT) {
        lic.devices = (lic.devices || []).concat(deviceId);
        this.put(code, lic);
      }
      return jres(200, { ok: true, status: lic.status });
    }

    /* ── CUSTOMER: poll for activation, and sign in once the admin has bound a line ── */
    if (path === '/api/activate') {
      const primaryCode = normalizeCode(body.code);
      const loginCode = normalizeLoginCode(body.code);
      const deviceId = String(body.deviceId || '').trim().slice(0, 80);
      if ((!primaryCode && !loginCode) || !deviceId) return jres(400, { error: 'A valid 6-digit Login Code, 8-digit activation code, or MAC address is required.' });
      const lic = primaryCode ? this.get(primaryCode) : this.findByLoginCode(loginCode);
      if (!lic) return jres(200, { status: 'invalid' });
      const code = normalizeCode(lic.code) || primaryCode;
      if (lic.status === 'pending') return jres(200, { status: 'pending' });
      if (lic.status === 'blocked') return jres(200, { status: 'blocked' });
      if (lic.status === 'disabled') return jres(200, { status: 'disabled' });
      /* The IPTV side is checked first: with no portal there is nothing to watch regardless of the
         app fee, so its verdict wins when both have lapsed at once (server.js v23.9). */
      const iptvExp = iptvExpiryOf(lic);
      if (iptvExp && Date.now() > iptvExp) {
        lic.status = 'expired'; this.put(code, lic);
        return jres(200, { status: 'expired', subscriptionEnabled: false, iptvExpiresAt: iptvExp });
      }
      const appExp = appExpiryOf(lic);
      if (lic.status === 'active' && appExp && Date.now() > appExp) {
        return jres(200, { status: 'app_expired', subscriptionEnabled: false, iptvExpiresAt: iptvExp, appExpiresAt: appExp });
      }
      if (lic.status === 'active') {
        const devices = lic.devices || [];
        if (devices.indexOf(deviceId) < 0) {
          if (devices.length >= LIMIT) {
            lic.status = 'blocked'; lic.blockedAt = Date.now(); this.put(code, lic);
            return jres(200, { status: 'blocked' });
          }
          devices.push(deviceId); lic.devices = devices;
        }
        lic.lastLogin = Date.now();
        this.put(code, lic);
        return jres(200, {
          status: 'active', code: lic.code, loginCode: lic.loginCode || '', kind: normalizeKind(lic.kind, lic.user), portalUrl: lic.url,
          username: lic.user, password: lic.pass, devices: (lic.devices || []).length,
          deviceLimit: LIMIT, iptvExpiresAt: iptvExp, appExpiresAt: appExp, subscriptionEnabled: false
        });
      }
      return jres(200, { status: lic.status || 'pending' });
    }

    /* ── CUSTOMER: "Clear registered users" on their own code ── */
    if (path === '/api/devices/reset') {
      const code = normalizeCode(body.code);
      const deviceId = String(body.deviceId || '').trim().slice(0, 80);
      if (!code || !deviceId) return jres(400, { error: 'A valid 8-digit code (or MAC address) and device are required.' });
      const lic = this.get(code);
      if (!lic) return jres(404, { error: 'This code is not registered yet.' });
      const had = (lic.devices || []).length;
      lic.devices = [deviceId];
      /* A device-limit block exists BECAUSE the list was full, so emptying it is the remedy. A
         block the seller applied by hand carries no blockedAt and is left alone. */
      if (lic.status === 'blocked' && lic.blockedAt) { lic.status = lic.url ? 'active' : 'pending'; delete lic.blockedAt; }
      this.put(code, lic);
      return jres(200, { ok: true, cleared: had, devices: 1, deviceLimit: LIMIT, status: lic.status });
    }

    /* ── ADMIN: bind a line to the code the customer read out ── */
    if (path === '/api/admin/activate') {
      const code = normalizeCode(body.code);
      if (!code) return jres(400, { error: 'Enter the customer’s 8-digit code or MAC address.' });
      const url_ = String(body.url || '').trim();
      const user = String(body.user || '').trim();
      const pass = String(body.pass != null ? body.pass : '').trim();
      const kind = normalizeKind(body.kind, user);
      const bad = validateLine(url_, user, kind);
      if (bad) return jres(400, { error: bad });
      const days = Number(body.days || 0);
      const existing = this.get(code);
      const lic = existing || { code, devices: [], createdAt: Date.now() };
      lic.status = 'active'; lic.url = url_; lic.user = user; lic.pass = pass; lic.kind = kind;
      lic.loginCode = lic.loginCode || this.freshLoginCode();
      if (!lic.loginCode) return jres(500, { error: 'Could not allocate a Login Code. Try again.' });
      lic.iptvExpiresAt = days > 0 ? Date.now() + days * 86400000 : 0;
      delete lic.expiresAt;
      lic.activatedAt = Date.now();
      this.put(code, lic);
      /* `created` means NO customer was waiting on this code — almost always a mistyped digit, and
         the dashboard warns loudly on it rather than letting a phantom code look like a success. */
      return jres(200, {
        ok: true, code, loginCode: lic.loginCode, status: 'active', created: !existing,
        devices: (lic.devices || []).length, deviceLimit: LIMIT, iptvExpiresAt: lic.iptvExpiresAt || 0
      });
    }

    /* ── ADMIN: mint a code that is already active (selling to someone who has not opened the app) ── */
    if (path === '/api/admin/create') {
      const url_ = String(body.url || '').trim();
      const user = String(body.user || '').trim();
      const pass = String(body.pass != null ? body.pass : '').trim();
      const kind = normalizeKind(body.kind, user);
      const bad = validateLine(url_, user, kind);
      if (bad) return jres(400, { error: bad });
      const days = Number(body.days || 0);
      const code = this.freshCode(randomDigits8);
      const loginCode = this.freshLoginCode();
      if (!code || !loginCode) return jres(500, { error: 'Could not allocate a free code. Try again.' });
      const lic = {
        code, status: 'active', devices: [], createdAt: Date.now(), activatedAt: Date.now(),
        url: url_, user, pass, kind, loginCode, iptvExpiresAt: days > 0 ? Date.now() + days * 86400000 : 0
      };
      this.put(code, lic);
      return jres(200, { ok: true, code, loginCode, status: 'active', devices: 0, deviceLimit: LIMIT, iptvExpiresAt: lic.iptvExpiresAt || 0 });
    }

    /* ── ADMIN: block / unblock / reset devices / edit / delete ── */
    if (path === '/api/admin/update') {
      const op = String(body.op || '').trim();

      if (op === 'delete') {
        const raw = Array.isArray(body.codes) ? body.codes : [body.code];
        const codes = [];
        for (const c of raw) { const n = normalizeCode(c); if (n && codes.indexOf(n) < 0) codes.push(n); }
        if (!codes.length) return jres(400, { error: 'Enter an 8-digit code or MAC address.' });
        if (codes.length > 500) return jres(400, { error: 'Too many codes in one request (max 500).' });
        for (const c of codes) this.del(c);
        return jres(200, { ok: true, deleted: codes.length, codes });
      }

      const code = normalizeCode(body.code);
      if (!code) return jres(400, { error: 'Enter an 8-digit code or MAC address.' });
      const lic = this.get(code);
      if (!lic) return jres(404, { error: 'Code not found.' });

      if (op === 'edit') {
        const url_ = String(body.url != null ? body.url : lic.url || '').trim();
        const user = String(body.user != null ? body.user : lic.user || '').trim();
        const kind = normalizeKind(body.kind != null ? body.kind : lic.kind, user);
        const bad = validateLine(url_, user, kind);
        if (bad) return jres(400, { error: bad });
        lic.url = url_; lic.user = user; lic.kind = kind;
        /* An empty password box means "leave it alone" — the dashboard cannot pre-fill it. */
        if (body.pass != null && String(body.pass).trim() !== '') lic.pass = String(body.pass).trim();
        /* Neither passwordless kind should keep a password left over from a username/password line. */
        if (kind === 'm3u' || kind === 'm3uurl') lic.pass = '';
        if (body.days != null && String(body.days) !== '') {
          const days = Number(body.days || 0);
          lic.iptvExpiresAt = days > 0 ? Date.now() + days * 86400000 : 0;
          delete lic.expiresAt;
        }
        if (lic.status === 'pending' && lic.url) { lic.status = 'active'; lic.activatedAt = Date.now(); }
        this.put(code, lic);
        return jres(200, { ok: true, status: lic.status, kind: lic.kind, devices: (lic.devices || []).length });
      }

      if (op === 'block') { lic.status = 'blocked'; delete lic.blockedAt; }
      else if (op === 'unblock') { lic.status = lic.url ? 'active' : 'pending'; delete lic.blockedAt; }
      else if (op === 'reset-devices') {
        lic.devices = [];
        if (lic.status === 'blocked' && lic.blockedAt) { lic.status = lic.url ? 'active' : 'pending'; delete lic.blockedAt; }
      }
      else return jres(400, { error: 'Unknown operation.' });
      this.put(code, lic);
      return jres(200, { ok: true, status: lic.status, devices: (lic.devices || []).length });
    }

    /* ── ADMIN: every code, for the dashboard table ── */
    if (path === '/api/admin/list') {
      const items = this.all().map(o => Object.assign({}, o, { devices: (o.devices || []).length }));
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return jres(200, { total: items.length, deviceLimit: LIMIT, codes: items });
    }

    return jres(404, { error: 'API endpoint not found' });
  }
}
