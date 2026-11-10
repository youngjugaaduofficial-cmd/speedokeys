'use strict';
// Key Store v2: accounts, wallet, key sales, admin panel.
// Zero dependencies. Needs Node.js 20.6 or newer.

const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : !!process.env.RENDER;
const ZAP_KEY = process.env.ZAP_KEY || process.env.ZAPUPI_API_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// Durable storage (recommended on free hosting): Upstash Redis over plain HTTPS
const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE_KEY = 'keystore_db_v2';
// Optional: encrypts the whole database (keys, users, orders) at rest. Keep this value safe: without it the data cannot be read.
const DB_ENC_KEY = process.env.DB_ENC_KEY ? crypto.createHash('sha256').update(process.env.DB_ENC_KEY).digest() : null;

if (!ADMIN_PASSWORD || !JWT_SECRET) {
  console.error('ADMIN_PASSWORD and JWT_SECRET must be set (see .env.example).');
  process.exit(1);
}
if (process.env.GATEWAY === 'zapupi' && !ZAP_KEY) {
  console.error('ZAPUPI_API_KEY (or ZAP_KEY) must be set when GATEWAY=zapupi.');
  process.exit(1);
}
if (process.env.GATEWAY === 'zapupi' && (process.env.ZAP_WEBHOOK_SECRET || '').length < 16) {
  console.error('ZAP_WEBHOOK_SECRET (16+ random characters) must be set when GATEWAY=zapupi.');
  process.exit(1);
}
if (REMOTE_URL && !REMOTE_TOKEN) {
  console.error('UPSTASH_REDIS_REST_TOKEN must be set together with UPSTASH_REDIS_REST_URL.');
  process.exit(1);
}

// ======================================================================
// Storage
// ======================================================================
const emptyDb = () => ({
  settings: {
    siteName: 'Key Store',
    announcement: '',
    maintenanceMode: false,
    maintenanceMessage: 'We are under maintenance. Please check back soon.',
    supportLink: '',
    supportText: 'Contact support',
    minTopupPaise: 1000,
    maxTopupPaise: 1000000,
    theme: 'electric',
    colors: {},
    navStyle: 'solid',
    gatewayFeePct: 2,
    contactEmail: '',
    accent: '',
    popup: '',
    popupActive: false,
    bannerSeconds: 5,
    dailyTopupLimitPaise: 5000000,
    newUserTopupLimitPaise: 300000,
    maxBuysPerHour: 40,
    welcomeBonusPaise: 0,
    bonusTiers: [],
    totpEnabled: false,
  },
  banners: [],
  audit: [],
  reviews: [],
  expenses: [],
  pages: {},
  tickets: [],
  notices: [],
  users: [],
  products: [],
  categories: [],
  keys: [],
  orders: [],
  payments: [],
  txns: [],
  coupons: [],
  referrals: [],
});
let db = emptyDb();

async function remote(cmd) {
  const r = await fetch(REMOTE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REMOTE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10000), // fail with a clear error instead of hanging forever
  });
  if (!r.ok) throw new Error('storage HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function loadDb() {
  let raw = null;
  if (REMOTE_URL) raw = await remote(['GET', REMOTE_KEY]);
  else if (fs.existsSync(DATA_FILE)) raw = fs.readFileSync(DATA_FILE, 'utf8');
  if (raw) {
    const parsed = JSON.parse(unpackDb(raw));
    db = Object.assign(emptyDb(), parsed, { settings: Object.assign(emptyDb().settings, parsed.settings || {}), referrals: Array.isArray(parsed.referrals) ? parsed.referrals : [] });
  }
  if (!['electric', 'ice', 'crimson', 'orange', 'white'].includes(db.settings.theme)) db.settings.theme = 'electric';
  // Backfill stable referral codes for accounts created before this feature.
  const usedCodes = new Set(db.users.map((u) => u.referralCode).filter(Boolean));
  let referralCodesAdded = false;
  for (const u of db.users) {
    if (!u.referralCode) {
      let code; do { code = 'SPD' + crypto.randomBytes(4).toString('hex').toUpperCase(); } while (usedCodes.has(code));
      u.referralCode = code; usedCodes.add(code); referralCodesAdded = true;
    }
  }
  if (referralCodesAdded) save();
}

let writeChain = Promise.resolve();
let pendingSave = Promise.resolve();
let saveFailed = false, retryTimer = null, lastPacked = 0, lastRaw = 0;
function packDb(json) {
  const gz = zlib.gzipSync(Buffer.from(json));
  if (!DB_ENC_KEY) return 'gz1:' + gz.toString('base64');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', DB_ENC_KEY, iv);
  const ct = Buffer.concat([c.update(gz), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function unpackDb(raw) {
  if (raw.startsWith('enc1:')) {
    if (!DB_ENC_KEY) throw new Error('Database is encrypted. Set the DB_ENC_KEY environment variable to the same value you used before.');
    const b = Buffer.from(raw.slice(5), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', DB_ENC_KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return zlib.gunzipSync(Buffer.concat([d.update(b.subarray(28)), d.final()])).toString('utf8');
  }
  if (raw.startsWith('gz1:')) return zlib.gunzipSync(Buffer.from(raw.slice(4), 'base64')).toString('utf8');
  return raw;
}
function save() {
  const json = JSON.stringify(db);
  const out = REMOTE_URL || DB_ENC_KEY ? packDb(json) : json;
  lastRaw = json.length; lastPacked = out.length;
  if (!REMOTE_URL) {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, DATA_FILE);
    return;
  }
  if (out.length > 900000) console.warn('Database is close to the free Upstash 1 MB limit.');
  writeChain = writeChain.catch(() => {}).then(() => remote(['SET', REMOTE_KEY, out]));
  pendingSave = writeChain;
  writeChain.then(() => { saveFailed = false; }).catch((e) => {
    saveFailed = true;
    console.error('SAVE FAILED (will retry):', e.message);
    if (!retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; if (saveFailed) save(); }, 5000); retryTimer.unref(); }
  });
}

// ======================================================================
// Helpers
// ======================================================================
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const istDay = (ts) => new Date(ts + 19800000).toISOString().slice(0, 10);
const rupees = (paise) => paise / 100;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function b32dec(str) { let bits = ''; for (const c of str.toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); } const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); }
function totpAt(secret, t) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = crypto.createHmac('sha1', b32dec(secret)).update(b).digest(); const o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0'); }
function totpOk(secret, code) { code = String(code || '').replace(/\s/g, ''); return [-1, 0, 1].some((d) => safeEqual(totpAt(secret, now() + d * 30000), code)); }

function signToken(payload, ttlSeconds) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(now() / 1000) + ttlSeconds }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function readToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!safeEqual(parts[2], expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return p.exp > Math.floor(now() / 1000) ? p : null;
  } catch (_) {
    return null;
  }
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(`${salt.toString('hex')}:${key.toString('hex')}`)));
  });
}
function checkPassword(password, stored) {
  return new Promise((resolve) => {
    const [saltHex, keyHex] = String(stored).split(':');
    if (!saltHex || !keyHex) return resolve(false);
    crypto.scrypt(password, Buffer.from(saltHex, 'hex'), 64, (err, key) => {
      resolve(!err && safeEqual(key.toString('hex'), keyHex));
    });
  });
}

const limits = new Map();
function limit(key, max, windowMs) {
  const t = now();
  const rec = limits.get(key);
  if (!rec || t - rec.since > windowMs) {
    limits.set(key, { count: 1, since: t });
    return;
  }
  rec.count += 1;
  if (rec.count > max) fail(429, 'Too many attempts. Please try again later.');
}
setInterval(() => {
  const t = now();
  for (const [k, v] of limits) if (t - v.since > 3600 * 1000) limits.delete(k);
}, 600 * 1000).unref();

const publicUser = (u) => ({ id: u.id, username: u.username, balance: rupees(u.balancePaise), createdAt: u.createdAt });
const ratingOf = (pid) => { const r = (db.reviews || []).filter((x) => x.productId === pid); return { avg: r.length ? Math.round((r.reduce((t, x) => t + x.rating, 0) / r.length) * 10) / 10 : 0, count: r.length }; };
const stockOf = (productId) => db.keys.filter((k) => k.productId === productId && k.status === 'available').length;

function addTxn(user, type, amountPaise, note) {
  user.balancePaise += amountPaise;
  db.txns.push({ id: uid(), userId: user.id, type, amountPaise, balanceAfter: user.balancePaise, note: note || '', createdAt: now() });
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

// ======================================================================
// Payment gateway adapters
// ======================================================================
// A gateway needs two functions:
//   create(payment, ctx) -> { ref, payUrl }          start a payment
//   check(payment)       -> { status, amountPaise }  status: 'paid' | 'pending' | 'failed'
const GATEWAY = process.env.GATEWAY || 'mock';
const gateways = {
  // Test mode: nothing is charged. The app shows a "simulate payment" button.
  mock: {
    async create(payment) {
      return { ref: 'mock_' + payment.id, payUrl: null };
    },
    async check() {
      return { status: 'pending' };
    },
  },
  // ZapUPI: create-order is connected. Status check is NOT connected yet
  // (waiting for ZapUPI's status/webhook docs), so payments stay 'pending'
  // and are never auto-credited. Admin can approve manually meanwhile.
  zapupi: {
    async create(payment, ctx) {
      // ZapUPI wants a short alphanumeric id (like ORD12345), not a UUID with hyphens.
      const zapOrderId = 'ORD' + payment.id.replace(/-/g, '').slice(0, 16).toUpperCase();
      let r;
      try {
        r = await fetch('https://pay.zapupi.com/api/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            zap_key: ZAP_KEY,
            order_id: zapOrderId,
            amount: payment.amountPaise / 100,
            success_url: ctx.returnUrl,
            failed_url: ctx.returnUrl,
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        // Do not auto-retry: a timeout may happen after ZapUPI created the order,
        // so retrying could create duplicate orders.
        const causeCode = e && e.cause && e.cause.code ? String(e.cause.code) : '';
        const detail = causeCode || (e && e.name === 'TimeoutError' ? 'TIMEOUT' : (e && e.name) || 'NETWORK_ERROR');
        console.error('ZapUPI create-order network error:', detail, e && e.message ? e.message : '');
        throw new Error('ZapUPI network request failed (' + detail + '). Check gateway availability and Render outbound network.');
      }

      const responseText = await r.text();
      let j = {};
      try {
        j = responseText ? JSON.parse(responseText) : {};
      } catch (_) {
        console.error('ZapUPI returned non-JSON response; HTTP', r.status);
        throw new Error('ZapUPI returned an invalid response (HTTP ' + r.status + ')');
      }
      if (!r.ok) {
        console.error('ZapUPI create-order HTTP error:', r.status, 'response fields:', Object.keys(j || {}).join(','));
        throw new Error('ZapUPI HTTP ' + r.status);
      }
      const d = j.data || j;
      const payUrl = d.payment_url || d.payUrl || d.pay_url || d.url || d.link || null;
      console.log('ZapUPI create-order result:', JSON.stringify({
        status: j.status || d.status || 'unknown',
        orderCreated: !!payUrl,
        httpStatus: r.status,
        orderId: zapOrderId,
      }));
      if (!payUrl) throw new Error('ZapUPI response had no payment URL (HTTP ' + r.status + ')');
      return { ref: zapOrderId, payUrl };
    },
    // Optional: set ZAP_STATUS_URL (from ZapUPI's docs) to verify payments with ZapUPI directly.
    // Without it, credits only come from the secured webhook or manual admin approval.
    async check(payment) {
      const url = process.env.ZAP_STATUS_URL;
      if (!url) return { status: 'pending' };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zap_key: ZAP_KEY, order_id: payment.ref }), signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => ({}));
      const d = j.data || j;
      const st = String(d.status || j.status || '').toLowerCase();
      const amt = Math.round(Number(d.amount !== undefined ? d.amount : d.pay_amount) * 100);
      if (['success', 'paid', 'completed'].includes(st) && Number.isFinite(amt)) return { status: 'paid', amountPaise: amt };
      if (['failed', 'cancelled', 'expired'].includes(st)) return { status: 'failed' };
      return { status: 'pending' };
    },
  },
};
if (!gateways[GATEWAY]) {
  console.error('Unknown GATEWAY: ' + GATEWAY);
  process.exit(1);
}
const MOCK_MODE = GATEWAY === 'mock';
const gateway = gateways[GATEWAY];

// Credits the wallet once. Safe to call many times for the same payment.
function settlePayment(pay, note) {
  if (pay.status === 'paid') return pay;
  const user = db.users.find((u) => u.id === pay.userId);
  pay.status = 'paid';
  pay.paidAt = now();
  if (user) {
    addTxn(user, 'topup', pay.amountPaise, note || 'Wallet top-up');
    const tier = (db.settings.bonusTiers || []).filter((t) => pay.amountPaise >= t.minPaise).sort((a, b) => b.minPaise - a.minPaise)[0];
    if (tier && tier.bonusPaise > 0) addTxn(user, 'bonus', tier.bonusPaise, 'Top-up bonus');
  }
  save();
  return pay;
}

// ======================================================================
// Mini router
// ======================================================================
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') {
    handler = opts;
    opts = {};
  }
  const names = [];
  const rx = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
  if (opts && opts.auth === 'admin' && method !== 'GET') {
    const inner = handler;
    handler = async (ctx) => {
      const out = await inner(ctx);
      try {
        (db.audit = db.audit || []).push({ at: now(), m: method, p: pattern, ip: ctx.ip || '' });
        if (db.audit.length > 300) db.audit.splice(0, db.audit.length - 300);
        save();
      } catch (e) {}
      return out;
    };
  }
  routes.push({ method, rx, names, opts, handler });
}
const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};
const reply = (status, body) => ({ __status: status, body });

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/admin': 'admin.html', '/admin/': 'admin.html' };
function servePage(res, file) {
  const html = fs.readFileSync(path.join(__dirname, file));
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
  if (file === 'admin.html') headers['X-Robots-Tag'] = 'noindex, nofollow';
  res.writeHead(200, headers);
  res.end(html);
}

function authUser(req) {
  const h = req.headers['authorization'] || '';
  const p = h.startsWith('Bearer ') ? readToken(h.slice(7)) : null;
  if (!p || p.role !== 'user') fail(401, 'Please log in');
  const user = db.users.find((u) => u.id === p.uid);
  if (!user) fail(401, 'Please log in again');
  if (user.banned) fail(403, 'This account has been blocked');
  if (user.tv !== p.tv) fail(401, 'Please log in again');
  return user;
}
function authAdmin(req) {
  const h = req.headers['authorization'] || '';
  const p = h.startsWith('Bearer ') ? readToken(h.slice(7)) : null;
  if (!p || p.role !== 'admin') fail(401, 'Unauthorized');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && PAGES[url.pathname]) return servePage(res, PAGES[url.pathname]);
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ name: db.settings.siteName, short_name: String(db.settings.siteName).slice(0, 12), start_url: '/', display: 'standalone', background_color: '#07080f', theme_color: '#07080f', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] }));
    }
    if (req.method === 'GET' && url.pathname === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#07080f"/><circle cx="190" cy="256" r="84" fill="none" stroke="' + (db.settings.accent || '#b6ff3c') + '" stroke-width="40"/><path d="M270 256h170M380 256v70M330 256v50" stroke="' + (db.settings.accent || '#b6ff3c') + '" stroke-width="40" stroke-linecap="round" fill="none"/></svg>');
    }
    if (req.method === 'GET' && url.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      return res.end("const C='ks-v1';self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.add('/')))});self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname.startsWith('/admin'))return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(C).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))))});");
    }
    if (req.method === 'GET' && (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml')) {
      const base = PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(`User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`); }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['', '#/p/faq', '#/p/about', '#/p/terms', '#/p/privacy', '#/p/refund', '#/p/contact'].map((p) => `<url><loc>${base}/${p}</loc></url>`).join('')}</urlset>`);
    }
    let matched = null;
    const params = {};
    let otherMethod = false;
    for (const r of routes) {
      const m = r.rx.exec(url.pathname);
      if (!m) continue;
      if (r.method !== req.method) {
        otherMethod = true;
        continue;
      }
      matched = r;
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      break;
    }
    if (!matched) return sendJson(res, otherMethod ? 405 : 404, { error: 'Not found' });

    const ip = TRUST_PROXY
      ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
      : req.socket.remoteAddress;

    let user = null;
    if (matched.opts.auth === 'user') user = authUser(req);
    if (matched.opts.auth === 'admin') authAdmin(req);

    const raw = req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readBody(req, 420 * 1024);
    let body = {};
    if (!matched.opts.raw && raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }
      if (body === null || typeof body !== 'object') body = {};
    }

    const result = await matched.handler({ req, res, params, query: url.searchParams, body, raw, ip, user });
    if (result && result.__raw) return;
    if (req.method !== 'GET') { try { await pendingSave; } catch (_) { /* kept in memory, retried in background */ } }
    if (result && result.__status) return sendJson(res, result.__status, result.body);
    sendJson(res, 200, result === undefined ? { ok: true } : result);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Server error' });
  }
});

// ======================================================================
// Public routes
// ======================================================================
route('GET', '/api/health', () => ({ ok: true, gateway: GATEWAY, saving: !saveFailed }));

route('GET', '/api/config', () => ({
  siteName: db.settings.siteName,
  announcement: db.settings.announcement,
  supportLink: db.settings.supportLink,
  supportText: db.settings.supportText,
  minTopup: rupees(db.settings.minTopupPaise),
  maxTopup: rupees(db.settings.maxTopupPaise),
  testMode: MOCK_MODE,
  maintenanceMode: !!db.settings.maintenanceMode,
  maintenanceMessage: db.settings.maintenanceMessage || 'We are under maintenance. Please check back soon.',
  theme: db.settings.theme || 'electric',
  colors: db.settings.colors || {},
  navStyle: db.settings.navStyle || 'solid',
  contactEmail: db.settings.contactEmail || '',
  accent: db.settings.accent || '',
  popup: db.settings.popupActive ? db.settings.popup || '' : '',
  bannerSeconds: db.settings.bannerSeconds || 5,
  welcomeBonus: rupees(db.settings.welcomeBonusPaise || 0),
  bonusTiers: (db.settings.bonusTiers || []).map((t) => ({ min: rupees(t.minPaise), bonus: rupees(t.bonusPaise) })),
}));

route('GET', '/api/banners', () =>
  (db.banners || []).filter((b) => b.active).sort((a, b) => a.order - b.order).map((b) => ({ id: b.id, image: b.image, link: b.link || '', title: b.title || '' }))
);

route('GET', '/api/products', () =>
  db.products
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      category: p.category || '',
      websiteUrl: p.websiteUrl || '',
      price: rupees(p.pricePaise),
      mrp: p.mrpPaise > p.pricePaise ? rupees(p.mrpPaise) : 0,
      image: p.image || '',
      gallery: p.gallery || [],
      region: p.region || '',
      denomination: p.denomination || '',
      badge: p.badge || '',
      featured: !!p.featured,
      steps: p.steps || '',
      rating: ratingOf(p.id),
      inStock: db.settings.maintenanceMode ? 0 : stockOf(p.id),
    }))
);

// ----- accounts -----
const USERNAME_RX = /^[A-Za-z0-9_]{3,20}$/;

route('POST', '/api/signup', async ({ body, ip }) => {
  limit('signup:' + ip, 8, 3600 * 1000);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RX.test(username)) fail(400, 'Username must be 3 to 20 letters, numbers or _');
  if (password.length < 6 || password.length > 100) fail(400, 'Password must be at least 6 characters');
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) fail(409, 'That username is taken');
  const rawCode = String(body.referralCode || '').trim().toUpperCase();
  let referrer = null;
  if (rawCode) {
    referrer = db.users.find((u) => u.referralCode && u.referralCode.toUpperCase() === rawCode);
    if (!referrer) fail(400, 'Referral code is invalid');
  }
  const user = {
    id: uid(), username, passHash: await hashPassword(password), balancePaise: 0,
    banned: false, tv: 1, createdAt: now(), lastLogin: now(), signupIp: ip || '',
    referralCode: 'SPD' + crypto.randomBytes(4).toString('hex').toUpperCase(),
  };
  while (db.users.some((u) => u.referralCode === user.referralCode)) user.referralCode = 'SPD' + crypto.randomBytes(4).toString('hex').toUpperCase();
  db.users.push(user);
  if (db.settings.welcomeBonusPaise > 0 && !(ip && db.users.some((x) => x !== user && x.signupIp === ip && x.welcomeGiven))) {
    addTxn(user, 'bonus', db.settings.welcomeBonusPaise, 'Welcome bonus');
    user.welcomeGiven = true;
  }
  if (referrer && referrer.id !== user.id) db.referrals.push({ id: uid(), referrerId: referrer.id, referredUserId: user.id, code: rawCode, status: 'pending', rewardPaise: Number.isSafeInteger(db.settings.referralRewardPaise) ? db.settings.referralRewardPaise : 1000, createdAt: now(), rewardedAt: null });
  save();
  return { token: signToken({ role: 'user', uid: user.id, tv: user.tv }, 30 * 86400), user: publicUser(user) };
});

route('POST', '/api/login', async ({ body, ip }) => {
  const username = String(body.username || '').trim();
  limit('login:' + ip, 30, 15 * 60 * 1000);
  limit('loginu:' + username.toLowerCase(), 10, 15 * 60 * 1000);
  const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  const ok = user ? await checkPassword(String(body.password || ''), user.passHash) : false;
  if (!user || !ok) fail(401, 'Wrong username or password');
  if (user.banned) fail(403, 'This account has been blocked');
  user.lastLogin = now();
  save();
  return { token: signToken({ role: 'user', uid: user.id, tv: user.tv }, 30 * 86400), user: publicUser(user) };
});

route('GET', '/api/me', { auth: 'user' }, ({ user }) => {
  const orders = db.orders.filter((o) => o.userId === user.id && o.status === 'completed');
  return {
    ...publicUser(user),
    orderCount: orders.length,
    totalSpent: rupees(orders.reduce((s, o) => s + o.pricePaise, 0)),
    referralCode: user.referralCode || null,
  };
});

route('GET', '/api/referrals', { auth: 'user' }, ({ user }) => {
  const mine = db.referrals.filter((r) => r.referrerId === user.id);
  return {
    code: user.referralCode,
    reward: rupees(Number.isSafeInteger(db.settings.referralRewardPaise) ? db.settings.referralRewardPaise : 1000),
    total: mine.length,
    rewarded: mine.filter((r) => r.status === 'rewarded').length,
    pending: mine.filter((r) => r.status === 'pending').length,
    earned: rupees(mine.filter((r) => r.status === 'rewarded').reduce((sum, r) => sum + r.rewardPaise, 0)),
    referrals: mine.slice().sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ status: r.status, createdAt: r.createdAt, rewardedAt: r.rewardedAt })),
  };
});

route('POST', '/api/me/password', { auth: 'user' }, async ({ user, body }) => {
  limit('pw:' + user.id, 10, 15 * 60 * 1000);
  const next = String(body.next || '');
  if (!(await checkPassword(String(body.current || ''), user.passHash))) fail(400, 'Current password is wrong');
  if (next.length < 6 || next.length > 100) fail(400, 'New password must be at least 6 characters');
  user.passHash = await hashPassword(next);
  user.tv += 1; // logs out every other device
  save();
  return { token: signToken({ role: 'user', uid: user.id, tv: user.tv }, 30 * 86400) };
});

// ----- shopping -----
function couponDiscount(code, pricePaise) {
  if (!code) return { discountPaise: 0, coupon: null };
  const c = db.coupons.find((x) => x.code.toLowerCase() === String(code).trim().toLowerCase());
  if (!c || !c.active) fail(400, 'Invalid coupon code');
  if (c.expiresAt && c.expiresAt < now()) fail(400, 'This coupon has expired');
  if (c.maxUses > 0 && c.used >= c.maxUses) fail(400, 'This coupon has been fully used');
  if (c.minOrderPaise && pricePaise < c.minOrderPaise) fail(400, 'Order is too small for this coupon');
  const d = c.type === 'percent' ? Math.floor((pricePaise * c.value) / 100) : Math.round(c.value * 100);
  return { discountPaise: Math.min(d, pricePaise), coupon: c };
}

route('POST', '/api/coupon/check', { auth: 'user' }, ({ body }) => {
  const product = db.products.find((p) => p.id === body.productId && p.active);
  if (!product) fail(404, 'Product not found');
  const { discountPaise } = couponDiscount(body.code, product.pricePaise);
  return { discount: rupees(discountPaise), finalPrice: rupees(product.pricePaise - discountPaise) };
});

route('POST', '/api/buy', { auth: 'user' }, ({ user, body }) => {
  limit('buy:' + user.id, 30, 60 * 1000);
  limit('buyh:' + user.id, db.settings.maxBuysPerHour || 40, 3600 * 1000);
  if (db.settings.maintenanceMode) fail(503, db.settings.maintenanceMessage || 'Shop is under maintenance. Please try again later.');
  const product = db.products.find((p) => p.id === body.productId && p.active);
  if (!product) fail(404, 'Product not found');
  const { discountPaise, coupon } = couponDiscount(body.coupon, product.pricePaise);
  const price = product.pricePaise - discountPaise;
  if (user.balancePaise < price) {
    return reply(402, { error: 'Not enough balance', needed: rupees(price - user.balancePaise), balance: rupees(user.balancePaise) });
  }
  const key = db.keys.find((k) => k.productId === product.id && k.status === 'available');
  if (!key) fail(409, 'Out of stock');

  // From here on nothing awaits, so no other request can sneak in between these steps.
  const order = {
    id: uid(),
    userId: user.id,
    username: user.username,
    productId: product.id,
    productName: product.name,
    listPricePaise: product.pricePaise,
    pricePaise: price,
    couponCode: coupon ? coupon.code : null,
    keyId: key.id,
    status: 'completed',
    createdAt: now(),
  };
  key.status = 'sold';
  key.orderId = order.id;
  key.soldAt = now();
  order.costPaise = product.costPaise || 0;
  if (coupon) coupon.used += 1;
  addTxn(user, 'purchase', -price, product.name);
  db.orders.push(order);
  // One reward per referred account, only after its first successful key purchase.
  const referral = db.referrals.find((r) => r.referredUserId === user.id && r.status === 'pending');
  if (referral && referral.referrerId !== user.id) {
    const referrer = db.users.find((u) => u.id === referral.referrerId && !u.banned);
    if (referrer) {
      // Mobile networks share IPs, so a match is only flagged for review, never blocked.
      if (referrer.signupIp && referrer.signupIp === user.signupIp) referral.sameIp = true;
      addTxn(referrer, 'referral_reward', referral.rewardPaise, 'Referral reward for a friend’s first purchase');
      referral.status = 'rewarded';
      referral.rewardedAt = now();
    }
  }
  save();
  return { orderId: order.id, product: product.name, key: key.value, paid: rupees(price), balance: rupees(user.balancePaise) };
});

route('GET', '/api/orders', { auth: 'user' }, ({ user }) =>
  db.orders
    .filter((o) => o.userId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((o) => {
      const k = db.keys.find((x) => x.id === o.keyId);
      return {
        id: o.id,
        productId: o.productId,
        product: o.productName,
        listPrice: rupees(o.listPricePaise || o.pricePaise),
        coupon: o.couponCode || '',
        reviewed: db.reviews.some((r) => r.orderId === o.id),
        paid: rupees(o.pricePaise),
        status: o.status,
        key: o.status === 'completed' && k ? k.value : null,
        createdAt: o.createdAt,
      };
    })
);

// ----- wallet -----
route('GET', '/api/wallet', { auth: 'user' }, ({ user }) => ({
  balance: rupees(user.balancePaise),
  transactions: db.txns
    .filter((t) => t.userId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map((t) => ({ id: t.id, type: t.type, amount: rupees(t.amountPaise), note: t.note, createdAt: t.createdAt })),
}));

route('POST', '/api/topup', { auth: 'user', }, async ({ user, body, req }) => {
  limit('topup:' + user.id, 10, 3600 * 1000);
  const amountPaise = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise < db.settings.minTopupPaise || amountPaise > db.settings.maxTopupPaise) {
    fail(400, `Amount must be between ₹${rupees(db.settings.minTopupPaise)} and ₹${rupees(db.settings.maxTopupPaise)}`);
  }
  const used = db.payments.filter((p) => p.userId === user.id && ((p.status === 'paid' && now() - p.createdAt < 86400000) || (p.status === 'pending' && now() - p.createdAt < 7200000))).reduce((t, p) => t + p.amountPaise, 0);
  const cap = now() - user.createdAt < 86400000 ? db.settings.newUserTopupLimitPaise : db.settings.dailyTopupLimitPaise;
  if (used + amountPaise > cap) fail(429, `Top-up limit reached (₹${rupees(cap)} per day). Try again later or contact support.`);
  const pay = {
    id: uid(),
    userId: user.id,
    username: user.username,
    amountPaise,
    status: 'pending',
    gateway: GATEWAY,
    ref: null,
    payUrl: null,
    createdAt: now(),
    paidAt: null,
  };
  const baseUrl = PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  try {
    const g = await gateway.create(pay, { returnUrl: `${baseUrl}/?pay=${pay.id}` });
    pay.ref = g.ref;
    pay.payUrl = g.payUrl;
  } catch (e) {
    console.error('gateway create failed:', e.message);
    fail(502, 'Could not start the payment. Please try again.');
  }
  db.payments.push(pay);
  save();
  return { paymentId: pay.id, payUrl: pay.payUrl, amount: rupees(amountPaise), testMode: MOCK_MODE };
});

// The page calls this after the customer comes back from the payment app.
route('GET', '/api/payments/:id', { auth: 'user' }, async ({ user, params }) => {
  const pay = db.payments.find((p) => p.id === params.id && p.userId === user.id);
  if (!pay) fail(404, 'Payment not found');
  if (pay.status === 'pending' && !MOCK_MODE) {
    try {
      const r = await gateway.check(pay);
      if (r.status === 'paid' && r.amountPaise >= pay.amountPaise) settlePayment(pay, 'Wallet top-up');
      else if (r.status === 'failed') {
        pay.status = 'failed';
        save();
      }
    } catch (e) {
      console.error('gateway check failed:', e.message);
    }
  }
  return { id: pay.id, status: pay.status, amount: rupees(pay.amountPaise), balance: rupees(user.balancePaise) };
});

// Test mode only: pretend the customer paid.
route('POST', '/api/payments/:id/simulate', { auth: 'user' }, ({ user, params }) => {
  if (!MOCK_MODE) fail(404, 'Not found');
  const pay = db.payments.find((p) => p.id === params.id && p.userId === user.id);
  if (!pay) fail(404, 'Payment not found');
  settlePayment(pay, 'Wallet top-up (test)');
  return { id: pay.id, status: pay.status, amount: rupees(pay.amountPaise), balance: rupees(user.balancePaise) };
});

// ZapUPI webhook. Protected by: secret URL path, optional source-IP check,
// and strict matching of order id + amount. Credits a payment only once.
route('POST', '/api/zapupi/webhook/:secret', { raw: true }, ({ params, raw, ip }) => {
  if (GATEWAY !== 'zapupi' || !safeEqual(params.secret, process.env.ZAP_WEBHOOK_SECRET || '')) fail(404, 'Not found');
  const allowedIp = process.env.ZAP_WEBHOOK_IP;
  if (allowedIp && ip !== allowedIp) {
    console.warn('zapupi webhook: blocked IP', ip);
    fail(403, 'Forbidden');
  }
  const text = raw.toString('utf8');
  let data = {};
  try { data = JSON.parse(text); } catch (_) { data = Object.fromEntries(new URLSearchParams(text)); }
  console.log('zapupi webhook from', ip, JSON.stringify(data));

  const pay = db.payments.find((p) => p.ref === String(data.order_id || '') && p.gateway === 'zapupi');
  if (!pay) return { ok: true }; // unknown order (e.g. dashboard "Test" button): acknowledge, do nothing
  const status = String(data.status || '').toLowerCase();

  if (status === 'success' && pay.status === 'pending') {
    const amountPaise = Math.round(Number(data.amount) * 100);
    const paidPaise = data.pay_amount === undefined ? amountPaise : Math.round(Number(data.pay_amount) * 100);
    if (!Number.isFinite(amountPaise) || !Number.isFinite(paidPaise) || amountPaise !== pay.amountPaise || paidPaise < pay.amountPaise) {
      console.error('zapupi webhook: AMOUNT MISMATCH, not credited', pay.id, 'expected', pay.amountPaise, 'got', amountPaise, paidPaise);
      return { ok: true }; // admin can review and approve manually
    }
    if (data.txn_id) pay.txnId = String(data.txn_id);
    settlePayment(pay, 'Wallet top-up (UPI)');
  } else if (status === 'failed' && pay.status === 'pending') {
    pay.status = 'failed';
    save();
  }
  return { ok: true };
});

// ======================================================================
// Admin routes
// ======================================================================
route('POST', '/api/admin/login', ({ body, ip }) => {
  limit('admin:' + ip, 10, 15 * 60 * 1000);
  if (typeof body.password !== 'string' || !safeEqual(body.password, ADMIN_PASSWORD)) fail(401, 'Wrong password');
  if (db.settings.totpEnabled && db.settings.totpSecret) {
    if (!body.code) return reply(401, { error: 'Enter your 6-digit 2FA code', need2fa: true });
    if (!totpOk(db.settings.totpSecret, body.code)) fail(401, 'Wrong 2FA code');
  }
  return { token: signToken({ role: 'admin' }, 12 * 3600) };
});

const A = { auth: 'admin' };

route('GET', '/api/admin/stats', A, () => {
  const done = db.orders.filter((o) => o.status === 'completed');
  const today = istDay(now());
  const sum = (arr) => arr.reduce((s, o) => s + o.pricePaise, 0);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = istDay(now() - i * 86400000);
    const os = done.filter((o) => istDay(o.createdAt) === d);
    days.push({ date: d, orders: os.length, revenue: rupees(sum(os)) });
  }
  const byProduct = new Map();
  for (const o of done) {
    const r = byProduct.get(o.productName) || { name: o.productName, sold: 0, revenue: 0 };
    r.sold += 1;
    r.revenue += rupees(o.pricePaise);
    byProduct.set(o.productName, r);
  }
  const paidTopups = db.payments.filter((p) => p.status === 'paid');
  return {
    revenueTotal: rupees(sum(done)),
    revenueToday: rupees(sum(done.filter((o) => istDay(o.createdAt) === today))),
    ordersTotal: done.length,
    ordersToday: done.filter((o) => istDay(o.createdAt) === today).length,
    usersTotal: db.users.length,
    usersToday: db.users.filter((u) => istDay(u.createdAt) === today).length,
    walletBalances: rupees(db.users.reduce((s, u) => s + u.balancePaise, 0)),
    topupsTotal: rupees(paidTopups.reduce((s, p) => s + p.amountPaise, 0)),
    pendingPayments: db.payments.filter((p) => p.status === 'pending').length,
    stockTotal: db.keys.filter((k) => k.status === 'available').length,
    lowStock: db.products
      .filter((p) => p.active && stockOf(p.id) <= 3)
      .map((p) => ({ id: p.id, name: p.name, left: stockOf(p.id) })),
    topProducts: [...byProduct.values()].sort((a, b) => b.sold - a.sold).slice(0, 5),
    last7days: days,
    testMode: MOCK_MODE,
  };
});

function adminProduct(p) {
  const ks = db.keys.filter((k) => k.productId === p.id);
  return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    category: p.category || '',
    websiteUrl: p.websiteUrl || '',
    price: rupees(p.pricePaise),
    mrp: p.mrpPaise ? rupees(p.mrpPaise) : 0,
    cost: rupees(p.costPaise || 0),
    profit: rupees(p.pricePaise - (p.costPaise || 0)),
    image: p.image || '',
    gallery: p.gallery || [],
    region: p.region || '',
    denomination: p.denomination || '',
    badge: p.badge || '',
    featured: !!p.featured,
    steps: p.steps || '',
    rating: ratingOf(p.id),
    active: p.active,
    available: ks.filter((k) => k.status === 'available').length,
    sold: ks.filter((k) => k.status === 'sold').length,
  };
}
function readProductFields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 100) fail(400, 'Name required (max 100 characters)');
    out.name = name;
  }
  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 1 || price > 500000) fail(400, 'Price must be 1 to 500000');
    out.pricePaise = Math.round(price * 100);
  }
  if (body.description !== undefined) out.description = String(body.description).trim().slice(0, 300);
  if (body.category !== undefined) out.category = String(body.category).trim().slice(0, 50);
  if (body.websiteUrl !== undefined) {
    const rawUrl = String(body.websiteUrl || '').trim();
    if (rawUrl) { let parsed; try { parsed = new URL(rawUrl); } catch (_) { fail(400, 'Website link must be a valid https:// or http:// URL'); } if (!['http:', 'https:'].includes(parsed.protocol)) fail(400, 'Website link must start with http:// or https://'); }
    out.websiteUrl = rawUrl;
  }
  const okImg = (v) => { v = String(v || ''); if (!v) return ''; if (!/^https:\/\//i.test(v) && !/^data:image\/(png|jpeg|webp);base64,/i.test(v)) fail(400, 'Image must be an https link or an uploaded png/jpg/webp'); if (v.length > 160000) fail(400, 'Image too large. Use a smaller image or an https link.'); return v; };
  if (body.cost !== undefined) { const c = Number(body.cost); if (!Number.isFinite(c) || c < 0 || c > 500000) fail(400, 'Purchase cost must be 0 or more'); out.costPaise = Math.round(c * 100); }
  if (body.region !== undefined) out.region = String(body.region).trim().slice(0, 30);
  if (body.denomination !== undefined) out.denomination = String(body.denomination).trim().slice(0, 30);
  if (body.image !== undefined) out.image = okImg(body.image);
  if (body.gallery !== undefined) { if (!Array.isArray(body.gallery) || body.gallery.length > 3) fail(400, 'Up to 3 gallery images'); out.gallery = body.gallery.map(okImg).filter(Boolean); }
  if (body.badge !== undefined) out.badge = String(body.badge).trim().slice(0, 16);
  if (body.mrp !== undefined) { const m = Number(body.mrp); out.mrpPaise = Number.isFinite(m) && m > 0 ? Math.round(m * 100) : 0; }
  if (body.featured !== undefined) out.featured = body.featured === true || body.featured === 'true';
  if (body.steps !== undefined) out.steps = String(body.steps).trim().slice(0, 500);
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

route('GET', '/api/admin/categories', A, () => (db.categories || []).map((c) => ({ ...c, productCount: db.products.filter((p) => p.category === c.name).length })));
route('POST', '/api/admin/categories', A, ({ body }) => {
  const name = String(body.name || '').trim().slice(0, 50);
  if (!name) fail(400, 'Category name is required');
  if (!Array.isArray(db.categories)) db.categories = [];
  if (db.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) fail(409, 'Category already exists');
  const category = { id: uid(), name, createdAt: now() };
  db.categories.push(category); save(); return reply(201, category);
});
route('PUT', '/api/admin/categories/:id', A, ({ params, body }) => {
  const c = (db.categories || []).find((x) => x.id === params.id);
  if (!c) fail(404, 'Category not found');
  const name = String(body.name || '').trim().slice(0, 50);
  if (!name) fail(400, 'Category name is required');
  if (db.categories.some((x) => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase())) fail(409, 'Category already exists');
  const old = c.name; c.name = name;
  db.products.forEach((p) => { if (p.category === old) p.category = name; }); save(); return c;
});
route('DELETE', '/api/admin/categories/:id', A, ({ params }) => {
  const c = (db.categories || []).find((x) => x.id === params.id);
  if (!c) fail(404, 'Category not found');
  if (db.products.some((p) => p.category === c.name)) fail(409, 'Move or delete products in this category before deleting it');
  db.categories = db.categories.filter((x) => x.id !== c.id); save(); return { ok: true };
});

route('GET', '/api/admin/products', A, () => db.products.map(adminProduct));

route('POST', '/api/admin/products', A, ({ body }) => {
  const f = readProductFields(body, false);
  const p = { id: uid(), description: '', category: '', active: true, createdAt: now(), ...f };
  db.products.push(p);
  save();
  return reply(201, { id: p.id });
});

route('PUT', '/api/admin/products/:id', A, ({ params, body }) => {
  const p = db.products.find((x) => x.id === params.id);
  if (!p) fail(404, 'Not found');
  Object.assign(p, readProductFields(body, true));
  save();
  return adminProduct(p);
});

route('DELETE', '/api/admin/products/:id', A, ({ params }) => {
  const p = db.products.find((x) => x.id === params.id);
  if (!p) fail(404, 'Not found');
  db.keys = db.keys.filter((k) => !(k.productId === p.id && k.status === 'available'));
  db.products = db.products.filter((x) => x.id !== p.id);
  save();
  return { ok: true };
});

route('GET', '/api/admin/products/:id/keys', A, ({ params }) =>
  db.keys.filter((k) => k.productId === params.id).map((k) => ({ id: k.id, value: k.value, status: k.status }))
);

route('POST', '/api/admin/products/:id/keys', A, ({ params, body }) => {
  const p = db.products.find((x) => x.id === params.id);
  if (!p) fail(404, 'Not found');
  let list = body.keys;
  if (typeof list === 'string') list = list.split(/\r?\n/);
  if (!Array.isArray(list)) fail(400, 'keys required');
  const existing = new Set(db.keys.filter((k) => k.productId === p.id).map((k) => k.value));
  let added = 0;
  let skipped = 0;
  for (const rawKey of list.slice(0, 5000)) {
    const v = String(rawKey).trim();
    if (!v) continue;
    if (v.length > 500 || existing.has(v)) {
      skipped++;
      continue;
    }
    existing.add(v);
    db.keys.push({ id: uid(), productId: p.id, value: v, status: 'available', orderId: null, addedAt: now() });
    added++;
  }
  save();
  return { added, skipped };
});

route('POST', '/api/admin/products/:id/generate', A, ({ params, body }) => {
  const p = db.products.find((x) => x.id === params.id);
  if (!p) fail(404, 'Not found');
  const count = Math.min(Math.max(parseInt(body.count, 10) || 0, 1), 500);
  const prefix = String(body.prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const existing = new Set(db.keys.filter((k) => k.productId === p.id).map((k) => k.value));
  let made = 0;
  while (made < count) {
    const chars = [...crypto.randomBytes(12)].map((b) => alphabet[b % alphabet.length]);
    const core = [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
    const v = prefix ? `${prefix}-${core}` : core;
    if (existing.has(v)) continue;
    existing.add(v);
    db.keys.push({ id: uid(), productId: p.id, value: v, status: 'available', orderId: null, addedAt: now() });
    made++;
  }
  save();
  return { added: made };
});

route('DELETE', '/api/admin/keys/:id', A, ({ params }) => {
  const k = db.keys.find((x) => x.id === params.id);
  if (!k) fail(404, 'Not found');
  if (k.status !== 'available') fail(409, 'Only unsold keys can be deleted');
  db.keys = db.keys.filter((x) => x.id !== k.id);
  save();
  return { ok: true };
});

// ----- users -----
route('GET', '/api/admin/users', A, ({ query }) => {
  const q = (query.get('q') || '').toLowerCase();
  return db.users
    .filter((u) => !q || u.username.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 300)
    .map((u) => ({
      id: u.id,
      username: u.username,
      balance: rupees(u.balancePaise),
      banned: u.banned,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      orders: db.orders.filter((o) => o.userId === u.id && o.status === 'completed').length,
    }));
});

route('GET', '/api/admin/users/:id', A, ({ params }) => {
  const u = db.users.find((x) => x.id === params.id);
  if (!u) fail(404, 'Not found');
  return {
    id: u.id,
    username: u.username,
    balance: rupees(u.balancePaise),
    banned: u.banned,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
    transactions: db.txns
      .filter((t) => t.userId === u.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((t) => ({ type: t.type, amount: rupees(t.amountPaise), note: t.note, createdAt: t.createdAt })),
    orders: db.orders
      .filter((o) => o.userId === u.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((o) => ({ id: o.id, product: o.productName, paid: rupees(o.pricePaise), status: o.status, createdAt: o.createdAt })),
  };
});

route('POST', '/api/admin/users/:id/ban', A, ({ params, body }) => {
  const u = db.users.find((x) => x.id === params.id);
  if (!u) fail(404, 'Not found');
  u.banned = !!body.banned;
  if (u.banned) u.tv += 1;
  save();
  return { banned: u.banned };
});

route('POST', '/api/admin/users/:id/balance', A, ({ params, body }) => {
  const u = db.users.find((x) => x.id === params.id);
  if (!u) fail(404, 'Not found');
  const amountPaise = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise === 0 || Math.abs(amountPaise) > 10000000) fail(400, 'Enter an amount (use minus to deduct)');
  if (u.balancePaise + amountPaise < 0) fail(400, 'Balance cannot go below zero');
  addTxn(u, 'admin', amountPaise, String(body.note || 'Admin adjustment').slice(0, 100));
  save();
  return { balance: rupees(u.balancePaise) };
});

route('POST', '/api/admin/users/:id/password', A, async ({ params, body }) => {
  const u = db.users.find((x) => x.id === params.id);
  if (!u) fail(404, 'Not found');
  const generated = body.generate === true;
  const pw = generated ? crypto.randomBytes(9).toString('base64url') : String(body.password || '');
  if (pw.length < 6 || pw.length > 100) fail(400, 'Password must be at least 6 characters');
  u.passHash = await hashPassword(pw);
  u.tv += 1;
  save();
  return { ok: true, ...(generated ? { temporaryPassword: pw } : {}) };
});

// ----- orders and payments -----
function adminOrderRows(query) {
  const q = (query.get('q') || '').toLowerCase();
  const status = query.get('status') || '';
  return db.orders
    .filter((o) => (!status || o.status === status) && (!q || o.username.toLowerCase().includes(q) || o.productName.toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((o) => {
      const k = db.keys.find((x) => x.id === o.keyId);
      return {
        id: o.id,
        username: o.username,
        product: o.productName,
        paid: rupees(o.pricePaise),
        coupon: o.couponCode,
        status: o.status,
        key: k ? k.value : null,
        createdAt: o.createdAt,
      };
    });
}

route('GET', '/api/admin/orders', A, ({ query }) => adminOrderRows(query).slice(0, 300));

route('GET', '/api/admin/orders.csv', A, ({ res, query }) => {
  const rows = adminOrderRows(query);
  const lines = [['Date', 'User', 'Product', 'Paid (INR)', 'Coupon', 'Status', 'Key'].map(csvCell).join(',')];
  for (const o of rows) {
    lines.push([new Date(o.createdAt).toISOString(), o.username, o.product, o.paid, o.coupon || '', o.status, o.key || ''].map(csvCell).join(','));
  }
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orders.csv"' });
  res.end(lines.join('\n'));
  return { __raw: true };
});

route('POST', '/api/admin/orders/:id/refund', A, ({ params }) => {
  const o = db.orders.find((x) => x.id === params.id);
  if (!o) fail(404, 'Not found');
  if (o.status !== 'completed') fail(409, 'Already refunded');
  const u = db.users.find((x) => x.id === o.userId);
  if (!u) fail(404, 'User not found');
  o.status = 'refunded';
  addTxn(u, 'refund', o.pricePaise, 'Refund: ' + o.productName);
  save();
  return { ok: true };
});

route('GET', '/api/admin/payments', A, () =>
  db.payments
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 300)
    .map((p) => ({ id: p.id, username: p.username, amount: rupees(p.amountPaise), status: p.status, gateway: p.gateway, createdAt: p.createdAt }))
);

route('POST', '/api/admin/payments/:id/approve', A, ({ params }) => {
  const p = db.payments.find((x) => x.id === params.id);
  if (!p) fail(404, 'Not found');
  if (p.status === 'paid') fail(409, 'Already paid');
  if (p.status !== 'pending') fail(409, 'Only pending payments can be approved');
  settlePayment(p, 'Wallet top-up (approved by admin)');
  return { status: p.status };
});

// ----- coupons -----
route('GET', '/api/admin/coupons', A, () =>
  db.coupons.map((c) => ({
    id: c.id, code: c.code, type: c.type, value: c.value, maxUses: c.maxUses, used: c.used,
    expiresAt: c.expiresAt, active: c.active, highlight: !!c.highlight, minOrder: rupees(c.minOrderPaise || 0),
  }))
);

route('POST', '/api/admin/coupons', A, ({ body }) => {
  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) fail(400, 'Code must be 3 to 20 letters or numbers');
  if (db.coupons.some((c) => c.code === code)) fail(409, 'That code already exists');
  const type = body.type === 'flat' ? 'flat' : 'percent';
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100)) fail(400, 'Enter a valid discount');
  const days = Number(body.days);
  db.coupons.push({
    id: uid(),
    code,
    type,
    value,
    maxUses: Math.max(0, parseInt(body.maxUses, 10) || 0),
    used: 0,
    expiresAt: Number.isFinite(days) && days > 0 ? now() + days * 86400000 : null,
    minOrderPaise: Math.max(0, Math.round((Number(body.minOrder) || 0) * 100)),
    active: true,
    highlight: body.highlight === true,
    createdAt: now(),
  });
  save();
  return reply(201, { ok: true });
});

route('POST', '/api/admin/coupons/:id/highlight', A, ({ params }) => {
  const c = db.coupons.find((x) => x.id === params.id);
  if (!c) fail(404, 'Not found');
  c.highlight = !c.highlight;
  save();
  return { ok: true, highlight: c.highlight };
});

route('POST', '/api/admin/coupons/:id/toggle', A, ({ params }) => {
  const c = db.coupons.find((x) => x.id === params.id);
  if (!c) fail(404, 'Not found');
  c.active = !c.active;
  save();
  return { active: c.active };
});

route('DELETE', '/api/admin/coupons/:id', A, ({ params }) => {
  db.coupons = db.coupons.filter((x) => x.id !== params.id);
  save();
  return { ok: true };
});

// ----- settings -----
route('GET', '/api/admin/settings', A, () => ({
  siteName: db.settings.siteName,
  announcement: db.settings.announcement,
  supportLink: db.settings.supportLink,
  supportText: db.settings.supportText,
  maintenanceMode: !!db.settings.maintenanceMode,
  maintenanceMessage: db.settings.maintenanceMessage || 'We are under maintenance. Please check back soon.',
  referralReward: rupees(db.settings.referralRewardPaise === undefined ? 10 : db.settings.referralRewardPaise / 100),
  minTopup: rupees(db.settings.minTopupPaise),
  maxTopup: rupees(db.settings.maxTopupPaise),
  theme: db.settings.theme || 'electric',
  colors: db.settings.colors || {},
  navStyle: db.settings.navStyle || 'solid',
  gatewayFeePct: db.settings.gatewayFeePct,
  contactEmail: db.settings.contactEmail || '',
  accent: db.settings.accent || '',
  popup: db.settings.popup || '',
  popupActive: !!db.settings.popupActive,
  bannerSeconds: db.settings.bannerSeconds || 5,
  dailyTopupLimit: rupees(db.settings.dailyTopupLimitPaise),
  newUserTopupLimit: rupees(db.settings.newUserTopupLimitPaise),
  maxBuysPerHour: db.settings.maxBuysPerHour,
  welcomeBonus: rupees(db.settings.welcomeBonusPaise || 0),
  bonusTiers: (db.settings.bonusTiers || []).map((t) => ({ min: rupees(t.minPaise), bonus: rupees(t.bonusPaise) })),
  gateway: GATEWAY,
  storage: REMOTE_URL ? 'Upstash (durable)' : 'Local file (resets on free hosting)',
}));

route('POST', '/api/admin/notify', A, async ({ body }) => {
  const title = String(body.title || '').trim().slice(0, 100);
  const message = String(body.message || '').trim().slice(0, 300);
  if (!title || !message) fail(400, 'Title and message required');
  if (!process.env.ONESIGNAL_APP_ID || !process.env.ONESIGNAL_REST_API_KEY) fail(500, 'OneSignal not configured');
  const res = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`
    },
    body: JSON.stringify({
      app_id: process.env.ONESIGNAL_APP_ID,
      headings: { en: title },
      contents: { en: message },
      included_segments: ['All']
    })
  });
  const data = await res.json();
  if (!res.ok) fail(502, data.errors?.[0] || 'OneSignal error');
  return { ok: true, recipients: data.recipients || 0 };
});

route('PUT', '/api/admin/settings', A, ({ body }) => {
  const s = db.settings;
  if (body.siteName !== undefined) s.siteName = String(body.siteName).trim().slice(0, 40) || 'Key Store';
  if (body.announcement !== undefined) s.announcement = String(body.announcement).trim().slice(0, 300);
  if (body.maintenanceMode !== undefined) s.maintenanceMode = body.maintenanceMode === true || body.maintenanceMode === 'true';
  if (body.maintenanceMessage !== undefined) s.maintenanceMessage = String(body.maintenanceMessage).trim().slice(0, 300) || 'We are under maintenance. Please check back soon.';
  if (body.referralReward !== undefined) s.referralRewardPaise = Math.max(0, Math.min(1000000, Math.round(Number(body.referralReward) * 100) || 0));
  if (body.supportText !== undefined) s.supportText = String(body.supportText).trim().slice(0, 40);
  if (body.supportLink !== undefined) {
    const link = String(body.supportLink).trim();
    if (link && !/^https?:\/\//i.test(link)) fail(400, 'Support link must start with http:// or https://');
    s.supportLink = link.slice(0, 200);
  }
  if (body.theme !== undefined) { if (!['electric', 'ice', 'crimson', 'orange', 'white'].includes(body.theme)) fail(400, 'Unknown theme'); s.theme = body.theme; }
  if (body.colors !== undefined) {
    const c = {};
    for (const k of ['accent', 'accent2', 'bg', 'text', 'button', 'border']) { const v = String((body.colors || {})[k] || '').trim(); if (v) { if (!/^#[0-9a-fA-F]{6}$/.test(v)) fail(400, k + ' must look like #1fff6a'); c[k] = v; } }
    s.colors = c;
  }
  if (body.navStyle !== undefined) s.navStyle = body.navStyle === 'transparent' ? 'transparent' : 'solid';
  if (body.gatewayFeePct !== undefined) s.gatewayFeePct = Math.max(0, Math.min(10, Number(body.gatewayFeePct) || 0));
  if (body.contactEmail !== undefined) s.contactEmail = String(body.contactEmail).trim().slice(0, 80);
  if (body.accent !== undefined) { const a = String(body.accent).trim(); if (a && !/^#[0-9a-fA-F]{6}$/.test(a)) fail(400, 'Accent must look like #b6ff3c'); s.accent = a; }
  if (body.popup !== undefined) s.popup = String(body.popup).trim().slice(0, 300);
  if (body.popupActive !== undefined) s.popupActive = body.popupActive === true || body.popupActive === 'true';
  if (body.bannerSeconds !== undefined) s.bannerSeconds = Math.max(2, Math.min(15, Math.round(Number(body.bannerSeconds)) || 5));
  if (body.dailyTopupLimit !== undefined) s.dailyTopupLimitPaise = Math.max(10000, Math.min(100000000, Math.round(Number(body.dailyTopupLimit) * 100) || 5000000));
  if (body.newUserTopupLimit !== undefined) s.newUserTopupLimitPaise = Math.max(10000, Math.min(100000000, Math.round(Number(body.newUserTopupLimit) * 100) || 300000));
  if (body.maxBuysPerHour !== undefined) s.maxBuysPerHour = Math.max(1, Math.min(500, Math.round(Number(body.maxBuysPerHour)) || 40));
  if (body.welcomeBonus !== undefined) s.welcomeBonusPaise = Math.max(0, Math.min(100000, Math.round(Number(body.welcomeBonus) * 100) || 0));
  if (body.bonusTiers !== undefined) {
    if (!Array.isArray(body.bonusTiers) || body.bonusTiers.length > 6) fail(400, 'Up to 6 bonus tiers');
    s.bonusTiers = body.bonusTiers.map((t) => ({ minPaise: Math.round(Number(t.min) * 100), bonusPaise: Math.round(Number(t.bonus) * 100) })).filter((t) => t.minPaise >= 100 && t.bonusPaise >= 100);
  }
  if (body.minTopup !== undefined) s.minTopupPaise = Math.max(100, Math.round(Number(body.minTopup) * 100) || 1000);
  if (body.maxTopup !== undefined) s.maxTopupPaise = Math.max(s.minTopupPaise, Math.round(Number(body.maxTopup) * 100) || 1000000);
  save();
  return { ok: true };
});

// ----- banners (home slider) -----
function readBanner(body, partial) {
  const f = {};
  if (!partial || body.image !== undefined) {
    const img = String(body.image || '');
    if (!/^https:\/\//i.test(img) && !/^data:image\/(png|jpeg|webp);base64,/i.test(img)) fail(400, 'Image must be an https link or an uploaded png/jpg/webp');
    if (img.length > 330000) fail(400, 'Image too large. Use a smaller image or an https link.');
    f.image = img;
  }
  if (body.link !== undefined) {
    const l = String(body.link).trim();
    if (l && !/^https?:\/\//i.test(l)) fail(400, 'Link must start with http:// or https://');
    f.link = l.slice(0, 300);
  }
  if (body.title !== undefined) f.title = String(body.title).trim().slice(0, 80);
  if (body.active !== undefined) f.active = body.active === true || body.active === 'true';
  return f;
}
route('GET', '/api/admin/banners', A, () => (db.banners || []).slice().sort((a, b) => a.order - b.order));
route('POST', '/api/admin/banners', A, ({ body }) => {
  if ((db.banners || []).length >= 8) fail(400, 'Maximum 8 banners');
  const b = { id: uid(), link: '', title: '', active: true, createdAt: now(), order: Date.now(), ...readBanner(body, false) };
  db.banners.push(b);
  save();
  return reply(201, { id: b.id });
});
route('PUT', '/api/admin/banners/:id', A, ({ params, body }) => {
  const b = db.banners.find((x) => x.id === params.id);
  if (!b) fail(404, 'Not found');
  Object.assign(b, readBanner(body, true));
  if (body.move === 'up' || body.move === 'down') {
    const l = db.banners.slice().sort((x, y) => x.order - y.order);
    const i = l.indexOf(b), j = body.move === 'up' ? i - 1 : i + 1;
    if (l[j]) { const t = b.order; b.order = l[j].order; l[j].order = t; }
  }
  save();
  return { ok: true };
});
route('DELETE', '/api/admin/banners/:id', A, ({ params }) => {
  const i = db.banners.findIndex((x) => x.id === params.id);
  if (i < 0) fail(404, 'Not found');
  db.banners.splice(i, 1);
  save();
  return { ok: true };
});

route('GET', '/api/admin/audit', A, () => (db.audit || []).slice(-150).reverse());

// ----- reviews -----
const maskName = (n) => String(n).slice(0, 1) + '***' + String(n).slice(-1);
route('POST', '/api/reviews', { auth: 'user' }, ({ user, body }) => {
  limit('rev:' + user.id, 20, 3600 * 1000);
  const order = db.orders.find((o) => o.id === body.orderId && o.userId === user.id && o.status === 'completed');
  if (!order) fail(404, 'Order not found');
  if (db.reviews.some((r) => r.orderId === order.id)) fail(409, 'You already reviewed this order');
  const rating = Math.round(Number(body.rating));
  if (!(rating >= 1 && rating <= 5)) fail(400, 'Rating must be 1 to 5');
  db.reviews.push({ id: uid(), orderId: order.id, productId: order.productId, productName: order.productName, userId: user.id, username: user.username, rating, comment: String(body.comment || '').trim().slice(0, 140), createdAt: now() });
  save();
  return reply(201, { ok: true });
});
route('GET', '/api/products/:id/reviews', ({ params }) =>
  db.reviews.filter((r) => r.productId === params.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map((r) => ({ rating: r.rating, comment: r.comment, user: maskName(r.username), createdAt: r.createdAt }))
);
route('GET', '/api/admin/reviews', A, () => db.reviews.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200));
route('DELETE', '/api/admin/reviews/:id', A, ({ params }) => {
  const i = db.reviews.findIndex((r) => r.id === params.id);
  if (i < 0) fail(404, 'Not found');
  db.reviews.splice(i, 1);
  save();
  return { ok: true };
});

// ----- support tickets -----
const ticketOut = (t, admin) => ({ orderId: t.orderId || null, orderName: t.orderName || '', id: t.id, subject: t.subject, status: t.status, username: admin ? t.username : undefined, messages: t.messages, createdAt: t.createdAt, updatedAt: t.updatedAt, unread: admin ? !!t.unreadAdmin : !!t.unreadUser });
const cleanText = (v, min, max, what) => { const t = String(v || '').trim(); if (t.length < min || t.length > max) fail(400, `${what} must be ${min} to ${max} characters`); return t; };
route('GET', '/api/tickets', { auth: 'user' }, ({ user }) => db.tickets.filter((t) => t.userId === user.id).sort((a, b) => b.updatedAt - a.updatedAt).map((t) => ticketOut(t)));
route('POST', '/api/tickets', { auth: 'user' }, ({ user, body }) => {
  limit('tkt:' + user.id, 6, 3600 * 1000);
  if (db.tickets.filter((t) => t.userId === user.id && t.status === 'open').length >= 3) fail(429, 'You already have 3 open tickets. Please wait for a reply.');
  const subject = cleanText(body.subject, 3, 80, 'Subject'), message = cleanText(body.message, 5, 1000, 'Message');
  const linked = body.orderId ? db.orders.find((o) => o.id === body.orderId && o.userId === user.id) : null;
  if (body.orderId && !linked) fail(404, 'Order not found');
  const t = { id: uid(), userId: user.id, username: user.username, orderId: linked ? linked.id : null, orderName: linked ? linked.productName : '', subject, status: 'open', messages: [{ from: 'user', text: message, at: now() }], createdAt: now(), updatedAt: now(), unreadAdmin: true, unreadUser: false };
  db.tickets.push(t);
  save();
  return reply(201, ticketOut(t));
});
route('POST', '/api/tickets/:id/reply', { auth: 'user' }, ({ user, params, body }) => {
  limit('tktr:' + user.id, 30, 3600 * 1000);
  const t = db.tickets.find((x) => x.id === params.id && x.userId === user.id);
  if (!t) fail(404, 'Ticket not found');
  if (t.status !== 'open') fail(409, 'This ticket is closed. Please open a new one.');
  if (t.messages.length >= 100) fail(429, 'Too many messages in this ticket');
  t.messages.push({ from: 'user', text: cleanText(body.message, 1, 1000, 'Message'), at: now() });
  t.updatedAt = now(); t.unreadAdmin = true;
  save();
  return ticketOut(t);
});
route('POST', '/api/tickets/:id/read', { auth: 'user' }, ({ user, params }) => {
  const t = db.tickets.find((x) => x.id === params.id && x.userId === user.id);
  if (t && t.unreadUser) { t.unreadUser = false; save(); }
  return { ok: true };
});
route('GET', '/api/admin/tickets', A, () => db.tickets.slice().sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.updatedAt - a.updatedAt).slice(0, 200).map((t) => ticketOut(t, true)));
route('POST', '/api/admin/tickets/:id/reply', A, ({ params, body }) => {
  const t = db.tickets.find((x) => x.id === params.id);
  if (!t) fail(404, 'Not found');
  t.messages.push({ from: 'admin', text: cleanText(body.message, 1, 1000, 'Message'), at: now() });
  t.updatedAt = now(); t.unreadUser = true; t.unreadAdmin = false;
  save();
  return ticketOut(t, true);
});
route('POST', '/api/admin/tickets/:id/close', A, ({ params, body }) => {
  const t = db.tickets.find((x) => x.id === params.id);
  if (!t) fail(404, 'Not found');
  t.status = body.closed === false ? 'open' : 'closed'; t.unreadAdmin = false; t.updatedAt = now();
  save();
  return ticketOut(t, true);
});

// ----- in-app notices (inbox) -----
route('GET', '/api/notices', () => (db.notices || []).slice(-15).reverse().map((n) => ({ id: n.id, title: n.title, body: n.body, at: n.at })));
route('POST', '/api/admin/notices', A, ({ body }) => {
  const n = { id: uid(), title: cleanText(body.title, 2, 80, 'Title'), body: cleanText(body.body, 2, 400, 'Message'), at: now() };
  db.notices.push(n);
  if (db.notices.length > 50) db.notices.splice(0, db.notices.length - 50);
  save();
  return reply(201, n);
});
route('DELETE', '/api/admin/notices/:id', A, ({ params }) => {
  const i = db.notices.findIndex((n) => n.id === params.id);
  if (i < 0) fail(404, 'Not found');
  db.notices.splice(i, 1);
  save();
  return { ok: true };
});

// ----- admin: counts, search, system, 2FA -----
route('GET', '/api/admin/counts', A, () => ({ tickets: db.tickets.filter((t) => t.status === 'open' && t.unreadAdmin).length }));
route('GET', '/api/admin/search', A, ({ query }) => {
  const q = String(query.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return { users: [], orders: [], products: [], tickets: [] };
  return {
    users: db.users.filter((u) => u.username.toLowerCase().includes(q)).slice(0, 5).map((u) => ({ id: u.id, username: u.username, balance: rupees(u.balancePaise), banned: !!u.banned })),
    orders: db.orders.filter((o) => (o.productName + ' ' + o.username + ' ' + o.id).toLowerCase().includes(q)).slice(-5).reverse().map((o) => ({ id: o.id, product: o.productName, username: o.username, paid: rupees(o.pricePaise) })),
    products: db.products.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 5).map((p) => ({ id: p.id, name: p.name, price: rupees(p.pricePaise) })),
    tickets: db.tickets.filter((t) => t.subject.toLowerCase().includes(q)).slice(0, 5).map((t) => ({ id: t.id, subject: t.subject, username: t.username, status: t.status })),
  };
});
route('GET', '/api/admin/system', A, () => ({
  storage: REMOTE_URL ? 'Upstash Redis' : 'Local file',
  durable: !!REMOTE_URL,
  encrypted: !!DB_ENC_KEY,
  packedBytes: lastPacked || Buffer.byteLength(JSON.stringify(db)),
  rawBytes: lastRaw || Buffer.byteLength(JSON.stringify(db)),
  limitBytes: REMOTE_URL ? 1000000 : null,
  saveFailed,
  gateway: GATEWAY,
  paymentVerify: GATEWAY === 'mock' ? 'test mode' : process.env.ZAP_STATUS_URL ? 'webhook + status API' : 'secured webhook only',
  uptimeMin: Math.round(process.uptime() / 60),
  node: process.version,
  counts: { users: db.users.length, products: db.products.length, keys: db.keys.length, orders: db.orders.length, tickets: db.tickets.length, reviews: db.reviews.length },
}));
route('GET', '/api/admin/2fa', A, () => ({ enabled: !!db.settings.totpEnabled }));
route('POST', '/api/admin/2fa/setup', A, () => {
  if (db.settings.totpEnabled) fail(409, '2FA is already on. Turn it off first to set up again.');
  db.settings.totpPending = b32enc(crypto.randomBytes(20));
  save();
  return { secret: db.settings.totpPending, uri: 'otpauth://totp/KeyStore%20Admin?secret=' + db.settings.totpPending + '&issuer=KeyStore' };
});
route('POST', '/api/admin/2fa/enable', A, ({ body }) => {
  if (!db.settings.totpPending) fail(400, 'Start setup first');
  if (!totpOk(db.settings.totpPending, body.code)) fail(400, 'That code is wrong. Check the time on your phone and try again.');
  db.settings.totpSecret = db.settings.totpPending; db.settings.totpPending = undefined; db.settings.totpEnabled = true;
  save();
  return { ok: true };
});
route('POST', '/api/admin/2fa/disable', A, ({ body }) => {
  if (!db.settings.totpEnabled || !totpOk(db.settings.totpSecret, body.code)) fail(400, 'Wrong 2FA code');
  db.settings.totpEnabled = false; db.settings.totpSecret = undefined;
  save();
  return { ok: true };
});

// ======================================================================
// Cart checkout, analytics, inventory, pages, offers, SEO
// ======================================================================
const idemCache = new Map();
setInterval(() => { for (const [k, v] of idemCache) if (now() - v.at > 600000) idemCache.delete(k); }, 120000).unref();

function cartLines(items) {
  if (!Array.isArray(items) || !items.length || items.length > 10) fail(400, 'Your cart is empty');
  const lines = []; let subtotal = 0;
  for (const it of items) {
    const p = db.products.find((x) => x.id === it.productId && x.active);
    if (!p) fail(404, 'A product in your cart is no longer available');
    const qty = Math.floor(Number(it.qty));
    if (!(qty >= 1 && qty <= 10)) fail(400, 'Quantity must be 1 to 10');
    if (lines.some((l) => l.p.id === p.id)) fail(400, 'Duplicate product in cart');
    const stock = stockOf(p.id);
    if (stock < qty) fail(409, stock ? `${p.name}: only ${stock} left in stock` : `${p.name} is out of stock`);
    lines.push({ p, qty }); subtotal += p.pricePaise * qty;
  }
  return { lines, subtotal };
}
route('POST', '/api/coupon/cart', { auth: 'user' }, ({ body }) => {
  const { subtotal } = cartLines(body.items);
  const { discountPaise } = couponDiscount(body.code, subtotal);
  return { subtotal: rupees(subtotal), discount: rupees(discountPaise), total: rupees(subtotal - discountPaise) };
});
route('POST', '/api/checkout', { auth: 'user' }, ({ user, body }) => {
  limit('chk:' + user.id, 20, 60 * 1000);
  limit('buyh:' + user.id, db.settings.maxBuysPerHour || 40, 3600 * 1000);
  if (db.settings.maintenanceMode) fail(503, db.settings.maintenanceMessage || 'Shop is under maintenance. Please try again later.');
  const idem = String(body.idem || '').slice(0, 64);
  const ik = idem.length >= 8 ? user.id + ':' + idem : null;
  if (ik && idemCache.has(ik)) return idemCache.get(ik).result; // repeated request: same answer, no second delivery
  const { lines, subtotal } = cartLines(body.items);
  const { discountPaise, coupon } = couponDiscount(body.coupon, subtotal);
  const total = subtotal - discountPaise;
  if (user.balancePaise < total) return reply(402, { error: 'Not enough balance', needed: rupees(total - user.balancePaise), balance: rupees(user.balancePaise) });
  // Nothing below awaits, so the whole allocation is atomic inside this process.
  const units = [];
  for (const { p, qty } of lines) for (let n = 0; n < qty; n++) units.push({ p, share: Math.floor((discountPaise * p.pricePaise) / subtotal) });
  units[0].share += discountPaise - units.reduce((t, u) => t + u.share, 0);
  const groupId = uid(), items = [];
  for (const u of units) {
    const key = db.keys.find((k) => k.productId === u.p.id && k.status === 'available');
    const order = { id: uid(), groupId, userId: user.id, username: user.username, productId: u.p.id, productName: u.p.name, listPricePaise: u.p.pricePaise, pricePaise: Math.max(0, u.p.pricePaise - u.share), costPaise: u.p.costPaise || 0, couponCode: coupon ? coupon.code : null, keyId: key.id, status: 'completed', createdAt: now() };
    key.status = 'sold'; key.orderId = order.id; key.soldAt = now();
    db.orders.push(order);
    items.push({ orderId: order.id, product: u.p.name, key: key.value, paid: rupees(order.pricePaise) });
  }
  if (coupon) coupon.used += 1;
  addTxn(user, 'purchase', -total, units.length === 1 ? units[0].p.name : units.length + ' items');
  const referral = db.referrals.find((r) => r.referredUserId === user.id && r.status === 'pending');
  if (referral && referral.referrerId !== user.id) {
    const referrer = db.users.find((x) => x.id === referral.referrerId && !x.banned);
    if (referrer) {
      if (referrer.signupIp && referrer.signupIp === user.signupIp) referral.sameIp = true;
      addTxn(referrer, 'referral_reward', referral.rewardPaise, 'Referral reward for a friend’s first purchase');
      referral.status = 'rewarded'; referral.rewardedAt = now();
    }
  }
  save();
  const result = { groupId, items, paid: rupees(total), balance: rupees(user.balancePaise) };
  if (ik) idemCache.set(ik, { result, at: now() });
  return result;
});

// ----- analytics, inventory, expenses (admin) -----
route('GET', '/api/admin/analytics', A, ({ query }) => {
  const days = Math.max(1, Math.min(90, parseInt(query.get('days'), 10) || 30));
  const since = now() - days * 86400000;
  const costOf = (o) => (o.costPaise !== undefined ? o.costPaise : ((db.products.find((p) => p.id === o.productId) || {}).costPaise || 0));
  const orders = db.orders.filter((o) => o.status === 'completed' && o.createdAt >= since);
  const revenue = orders.reduce((t, o) => t + o.pricePaise, 0), cost = orders.reduce((t, o) => t + costOf(o), 0);
  const gross = revenue - cost, fee = Math.round((revenue * (db.settings.gatewayFeePct || 0)) / 100);
  const exp = (db.expenses || []).filter((e) => e.at >= since).reduce((t, e) => t + e.amountPaise, 0);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = istDay(now() - i * 86400000), os = orders.filter((o) => istDay(o.createdAt) === d);
    series.push({ day: d.slice(5), revenue: rupees(os.reduce((t, o) => t + o.pricePaise, 0)), profit: rupees(os.reduce((t, o) => t + o.pricePaise - costOf(o), 0)) });
  }
  const products = db.products.map((p) => {
    const os = orders.filter((o) => o.productId === p.id), ks = db.keys.filter((k) => k.productId === p.id);
    const avail = ks.filter((k) => k.status === 'available').length;
    return { id: p.id, name: p.name, units: os.length, revenue: rupees(os.reduce((t, o) => t + o.pricePaise, 0)), profit: rupees(os.reduce((t, o) => t + o.pricePaise - costOf(o), 0)), available: avail, soldTotal: ks.filter((k) => k.status === 'sold').length, stockValue: rupees(avail * (p.costPaise || 0)), unitProfit: rupees(p.pricePaise - (p.costPaise || 0)) };
  }).sort((a, b) => b.revenue - a.revenue);
  return { days, orders: orders.length, revenue: rupees(revenue), cost: rupees(cost), gross: rupees(gross), gatewayFee: rupees(fee), gatewayFeePct: db.settings.gatewayFeePct || 0, expenses: rupees(exp), net: rupees(gross - fee - exp), costMissing: orders.filter((o) => costOf(o) === 0).length, customers: db.users.length, series, products };
});
route('GET', '/api/admin/expenses', A, () => (db.expenses || []).slice().sort((a, b) => b.at - a.at).slice(0, 100).map((e) => ({ id: e.id, label: e.label, amount: rupees(e.amountPaise), at: e.at })));
route('POST', '/api/admin/expenses', A, ({ body }) => {
  const label = cleanText(body.label, 2, 60, 'Label'), amt = Number(body.amount);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 10000000) fail(400, 'Enter a valid amount');
  db.expenses.push({ id: uid(), label, amountPaise: Math.round(amt * 100), at: now() });
  save();
  return reply(201, { ok: true });
});
route('DELETE', '/api/admin/expenses/:id', A, ({ params }) => {
  const i = db.expenses.findIndex((e) => e.id === params.id);
  if (i < 0) fail(404, 'Not found');
  db.expenses.splice(i, 1); save();
  return { ok: true };
});
route('GET', '/api/admin/inventory', A, ({ query }) => {
  const pid = query.get('product') || '', st = query.get('status') || '', q = String(query.get('q') || '').trim().toLowerCase();
  const out = [];
  for (const k of db.keys) {
    if (pid && k.productId !== pid) continue;
    if (st && k.status !== st) continue;
    if (q && !k.value.toLowerCase().includes(q) && !(k.orderId || '').toLowerCase().includes(q)) continue;
    const p = db.products.find((x) => x.id === k.productId);
    out.push({ id: k.id, productId: k.productId, product: p ? p.name : '(deleted)', status: k.status, masked: '••••' + String(k.value).slice(-4), uploadedAt: k.addedAt || null, soldAt: k.soldAt || null, orderId: k.orderId || null });
    if (out.length >= 200) break;
  }
  return { total: out.length, keys: out };
});

// ----- store pages (editable text) -----
const DEFAULT_PAGES = {
  about: 'We sell digital gaming codes and access keys. Codes are delivered to your account right after payment. Contact support if anything looks wrong.',
  delivery: '1. Add coins to your wallet.\n2. Choose your product and complete checkout.\n3. Your code appears instantly on screen and stays saved in My Orders.\n4. Redeem it on the official service for that product.',
  terms: 'By using this store you agree to buy only for your own use and not to resell codes without permission. Prices and availability can change. Accounts that abuse the service may be blocked.',
  privacy: 'We store your username, order history and wallet activity to run the store. We do not sell your data. Contact support to ask for your account to be removed.',
  refund: 'Digital codes cannot be returned once delivered. If a code is invalid or already used, contact support within 24 hours with your order number and we will replace it or refund the amount to your wallet.',
  faq: [
    { q: 'How fast is delivery?', a: 'Your code is shown on screen as soon as your order completes and is also saved in My Orders.' },
    { q: 'What if my code does not work?', a: 'Open a support ticket from your account with the order number. Invalid codes are replaced or refunded to your wallet.' },
    { q: 'Can I withdraw wallet coins?', a: 'No. Wallet coins can only be used to buy products in this store.' },
    { q: 'Is the Google Play code valid in every country?', a: 'No. Check the region shown on the product before buying.' },
  ],
};
const pagesOut = () => ({ ...DEFAULT_PAGES, ...(db.settings.pages || {}) });
route('GET', '/api/pages', () => ({ ...pagesOut(), contactEmail: db.settings.contactEmail || '', whatsapp: db.settings.supportLink || '' }));
route('PUT', '/api/admin/pages', A, ({ body }) => {
  const p = { ...(db.settings.pages || {}) };
  for (const k of ['about', 'delivery', 'terms', 'privacy', 'refund']) if (body[k] !== undefined) p[k] = String(body[k]).slice(0, 4000);
  if (body.faq !== undefined) {
    if (!Array.isArray(body.faq) || body.faq.length > 20) fail(400, 'Up to 20 FAQ items');
    p.faq = body.faq.map((f) => ({ q: String(f.q || '').trim().slice(0, 160), a: String(f.a || '').trim().slice(0, 800) })).filter((f) => f.q && f.a);
  }
  db.settings.pages = p; save();
  return { ok: true };
});
route('GET', '/api/admin/pages', A, () => pagesOut());

// ----- offers + genuine reviews -----
route('GET', '/api/offers', () => db.coupons.filter((c) => c.active && c.highlight && (!c.expiresAt || c.expiresAt > now()) && !(c.maxUses > 0 && c.used >= c.maxUses)).slice(0, 4).map((c) => ({ code: c.code, label: c.type === 'percent' ? c.value + '% off' : '₹' + c.value + ' off', min: rupees(c.minOrderPaise || 0) })));
route('GET', '/api/reviews/recent', () => db.reviews.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map((r) => ({ rating: r.rating, comment: r.comment, product: r.productName, user: maskName(r.username), createdAt: r.createdAt })));

// ----- extra admin tools -----
route('GET', '/api/admin/users.csv', A, ({ res }) => {
  const lines = [['Joined', 'Username', 'Balance (INR)', 'Orders', 'Banned'].map(csvCell).join(',')];
  for (const u of db.users) lines.push([new Date(u.createdAt).toISOString(), u.username, rupees(u.balancePaise), db.orders.filter((o) => o.userId === u.id).length, u.banned ? 'yes' : 'no'].map(csvCell).join(','));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="users.csv"' });
  res.end(lines.join('\n'));
  return { __raw: true };
});
route('GET', '/api/admin/backup', A, ({ res }) => {
  const copy = { ...db, settings: { ...db.settings, totpSecret: undefined, totpPending: undefined }, users: db.users.map((u) => ({ ...u, passHash: undefined })) };
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="keystore-backup-' + istDay(now()) + '.json"' });
  res.end(JSON.stringify(copy));
  return { __raw: true };
});

// ======================================================================
// Start
// ======================================================================
async function start() {
  await loadDb();
  try { await pendingSave; } catch (_) {}
  if (GATEWAY !== 'mock' && process.env.ZAP_STATUS_URL) {
    setInterval(async () => {
      for (const p of db.payments.filter((x) => x.status === 'pending' && x.gateway === GATEWAY && now() - x.createdAt < 86400000).slice(0, 20)) {
        try { const r = await gateway.check(p); if (r.status === 'paid' && r.amountPaise >= p.amountPaise) settlePayment(p, 'Wallet top-up (UPI)'); else if (r.status === 'failed') { p.status = 'failed'; save(); } } catch (e) { console.error('status poll:', e.message); }
      }
    }, 60000).unref();
  }
  server.listen(PORT, () => {
    console.log(`Server on :${PORT} | payments: ${GATEWAY}${MOCK_MODE ? ' (TEST MODE, no real money)' : ''} | storage: ${REMOTE_URL ? 'Upstash' : 'file'}`);
  });
}
if (require.main === module) {
  start().catch((e) => {
    console.error('Startup failed:', e.message);
    process.exit(1);
  });
  process.on('SIGTERM', async () => {
    try { await pendingSave; } catch (_) {}
    process.exit(0);
  });
}
module.exports = { server, start, _db: () => db };
