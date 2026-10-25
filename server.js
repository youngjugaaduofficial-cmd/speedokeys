'use strict';
// Key Store v2: accounts, wallet, key sales, admin panel.
// Zero dependencies. Needs Node.js 20.6 or newer.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : !!process.env.RENDER;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// Durable storage (recommended on free hosting): Upstash Redis over plain HTTPS
const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE_KEY = 'keystore_db_v2';

if (!ADMIN_PASSWORD || !JWT_SECRET) {
  console.error('ADMIN_PASSWORD and JWT_SECRET must be set (see .env.example).');
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
    supportLink: '',
    supportText: 'Contact support',
    minTopupPaise: 1000,
    maxTopupPaise: 1000000,
  },
  users: [],
  products: [],
  keys: [],
  orders: [],
  payments: [],
  txns: [],
  coupons: [],
});
let db = emptyDb();

async function remote(cmd) {
  const r = await fetch(REMOTE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REMOTE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
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
    const parsed = JSON.parse(raw);
    db = Object.assign(emptyDb(), parsed, { settings: Object.assign(emptyDb().settings, parsed.settings || {}) });
  }
}

let writeChain = Promise.resolve();
let pendingSave = Promise.resolve();
function save() {
  const json = JSON.stringify(db);
  if (!REMOTE_URL) {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DATA_FILE);
    return;
  }
  if (json.length > 900000) console.warn('Database is getting large for the free Upstash limit (1 MB).');
  writeChain = writeChain
    .then(() => remote(['SET', REMOTE_KEY, json]))
    .catch((e) => console.error('SAVE FAILED:', e.message));
  pendingSave = writeChain;
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
const stockOf = (productId) => db.keys.filter((k) => k.productId === productId && k.status === 'available').length;

function addTxn(user, type, amountPaise, note) {
  user.balancePaise += amountPaise;
  db.txns.push({ id: uid(), userId: user.id, type, amountPaise, balanceAfter: user.balancePaise, note: note || '', createdAt: now() });
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// ======================================================================
// Payment gateway adapters
// ======================================================================
const GATEWAY = process.env.GATEWAY || 'mock';
const gateways = {
  mock: {
    async create(payment) {
      return { ref: 'mock_' + payment.id, payUrl: null };
    },
    async check() {
      return { status: 'pending' };
    },
  },
  zapupi: {
    async create(payment, ctx) {
      const res = await fetch('https://api.zapupi.com/v1/create_order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.ZAPUPI_API_KEY}`
        },
        body: JSON.stringify({
          amount: payment.amountPaise / 100,
          order_id: payment.id,
          redirect_url: ctx.returnUrl
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || 'ZapUPI connection failed');
      }
      return { ref: data.order_ref || payment.id, payUrl: data.payment_url };
    },
    async check(payment) {
      const res = await fetch(`https://api.zapupi.com/v1/status/${payment.ref}`, {
        headers: {
          'Authorization': `Bearer ${process.env.ZAPUPI_API_KEY}`
        }
      });
      const data = await res.json();
      let status = 'pending';
      if (data.status === 'SUCCESS' || data.status === 'paid') status = 'paid';
      else if (data.status === 'FAILED' || data.status === 'failed') status = 'failed';
      
      return { status, amountPaise: data.amount ? Math.round(data.amount * 100) : payment.amountPaise };
    },
  },
};

if (!gateways[GATEWAY]) {
  console.error('Unknown GATEWAY: ' + GATEWAY);
  process.exit(1);
}
const MOCK_MODE = GATEWAY === 'mock';
const gateway = gateways[GATEWAY];

function settlePayment(pay, note) {
  if (pay.status === 'paid') return pay;
  const user = db.users.find((u) => u.id === pay.userId);
  pay.status = 'paid';
  pay.paidAt = now();
  if (user) addTxn(user, 'topup', pay.amountPaise, note || 'Wallet top-up');
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

    const raw = req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readBody(req, 200 * 1024);
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
    if (req.method !== 'GET') await pendingSave;
    if (result && result.__status) return sendJson(res, result.__status, result.body);
    sendJson(res, 200, result === undefined ? { ok: true } : result);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Server error' });
  }
});

// ======================================================================
// Routes
// ======================================================================
route('GET', '/api/health', () => ({ ok: true, gateway: GATEWAY }));

route('GET', '/api/config', () => ({
  siteName: db.settings.siteName,
  announcement: db.settings.announcement,
  supportLink: db.settings.supportLink,
  supportText: db.settings.supportText,
  minTopup: rupees(db.settings.minTopupPaise),
  maxTopup: rupees(db.settings.maxTopupPaise),
  testMode: MOCK_MODE,
}));

route('GET', '/api/products', () =>
  db.products
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      category: p.category || '',
      price: rupees(p.pricePaise),
      inStock: stockOf(p.id),
    }))
);

const USERNAME_RX = /^[A-Za-z0-9_]{3,20}$/;

route('POST', '/api/signup', async ({ body, ip }) => {
  limit('signup:' + ip, 8, 3600 * 1000);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RX.test(username)) fail(400, 'Username must be 3 to 20 letters, numbers or _');
  if (password.length < 6 || password.length > 100) fail(400, 'Password must be at least 6 characters');
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) fail(409, 'That username is taken');
  const user = {
    id: uid(),
    username,
    passHash: await hashPassword(password),
    balancePaise: 0,
    banned: false,
    tv: 1,
    createdAt: now(),
    lastLogin: now(),
  };
  db.users.push(user);
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
  };
});

route('POST', '/api/me/password', { auth: 'user' }, async ({ user, body }) => {
  limit('pw:' + user.id, 10, 15 * 60 * 1000);
  const next = String(body.next || '');
  if (!(await checkPassword(String(body.current || ''), user.passHash))) fail(400, 'Current password is wrong');
  if (next.length < 6 || next.length > 100) fail(400, 'New password must be at least 6 characters');
  user.passHash = await hashPassword(next);
  user.tv += 1;
  save();
  return { token: signToken({ role: 'user', uid: user.id, tv: user.tv }, 30 * 86400) };
});

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
  const product = db.products.find((p) => p.id === body.productId && p.active);
  if (!product) fail(404, 'Product not found');
  const { discountPaise, coupon } = couponDiscount(body.coupon, product.pricePaise);
  const price = product.pricePaise - discountPaise;
  if (user.balancePaise < price) {
    return reply(402, { error: 'Not enough balance', needed: rupees(price - user.balancePaise), balance: rupees(user.balancePaise) });
  }
  const key = db.keys.find((k) => k.productId === product.id && k.status === 'available');
  if (!key) fail(409, 'Out of stock');

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
  if (coupon) coupon.used += 1;
  addTxn(user, 'purchase', -price, product.name);
  db.orders.push(order);
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
        product: o.productName,
        paid: rupees(o.pricePaise),
        status: o.status,
        key: o.status === 'completed' && k ? k.value : null,
        createdAt: o.createdAt,
      };
    })
);

route('GET', '/api/wallet', { auth: 'user' }, ({ user }) => ({
  balance: rupees(user.balancePaise),
  transactions: db.txns
    .filter((t) => t.userId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map((t) => ({ id: t.id, type: t.type, amount: rupees(t.amountPaise), note: t.note, createdAt: t.createdAt })),
}));

route('POST', '/api/topup', { auth: 'user' }, async ({ user, body, req }) => {
  limit('topup:' + user.id, 10, 3600 * 1000);
  const amountPaise = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise < db.settings.minTopupPaise || amountPaise > db.settings.maxTopupPaise) {
    fail(400, `Amount must be between ₹${rupees(db.settings.minTopupPaise)} and ₹${rupees(db.settings.maxTopupPaise)}`);
  }
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

route('POST', '/api/payments/:id/simulate', { auth: 'user' }, ({ user, params }) => {
  if (!MOCK_MODE) fail(404, 'Not found');
  const pay = db.payments.find((p) => p.id === params.id && p.userId === user.id);
  if (!pay) fail(404, 'Payment not found');
  settlePayment(pay, 'Wallet top-up (test)');
  return { id: pay.id, status: pay.status, amount: rupees(pay.amountPaise), balance: rupees(user.balancePaise) };
});

// ======================================================================
// Admin routes
// ======================================================================
route('POST', '/api/admin/login', ({ body, ip }) => {
  limit('admin:' + ip, 10, 15 * 60 * 1000);
  if (typeof body.password !== 'string' || !safeEqual(body.password, ADMIN_PASSWORD)) fail(401, 'Wrong password');
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
    price: rupees(p.pricePaise),
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
  if (body.category !== undefined) out.category = String(body.category).trim().slice(0, 30);
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

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
  const pw = String(body.password || '');
  if (pw.length < 6 || pw.length > 100) fail(400, 'Password must be at least 6 characters');
  u.passHash = await hashPassword(pw);
  u.tv += 1;
  save();
  return { ok: true };
});

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
  settlePayment(p, 'Wallet top-up (approved by admin)');
  return { status: p.status };
});

route('GET', '/api/admin/coupons', A, () =>
  db.coupons.map((c) => ({
    id: c.id, code: c.code, type: c.type, value: c.value, maxUses: c.maxUses, used: c.used,
    expiresAt: c.expiresAt, active: c.active, minOrder: rupees(c.minOrderPaise || 0),
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
    createdAt: now(),
  });
  save();
  return reply(201, { ok: true });
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

route('GET', '/api/admin/settings', A, () => ({
  siteName: db.settings.siteName,
  announcement: db.settings.announcement,
  supportLink: db.settings.supportLink,
  supportText: db.settings.supportText,
  minTopup: rupees(db.settings.minTopupPaise),
  maxTopup: rupees(db.settings.maxTopupPaise),
  gateway: GATEWAY,
  storage: REMOTE_URL ? 'Upstash (durable)' : 'Local file (resets on free hosting)',
}));

route('PUT', '/api/admin/settings', A, ({ body }) => {
  const s = db.settings;
  if (body.siteName !== undefined) s.siteName = String(body.siteName).trim().slice(0, 40) || 'Key Store';
  if (body.announcement !== undefined) s.announcement = String(body.announcement).trim().slice(0, 300);
  if (body.supportText !== undefined) s.supportText = String(body.supportText).trim().slice(0, 40);
  if (body.supportLink !== undefined) {
    const link = String(body.supportLink).trim();
    if (link && !/^https?:\/\//i.test(link)) fail(400, 'Support link must start with http:// or https://');
    s.supportLink = link.slice(0, 200);
  }
  if (body.minTopup !== undefined) s.minTopupPaise = Math.max(100, Math.round(Number(body.minTopup) * 100) || 1000);
  if (body.maxTopup !== undefined) s.maxTopupPaise = Math.max(s.minTopupPaise, Math.round(Number(body.maxTopup) * 100) || 1000000);
  save();
  return { ok: true };
});

async function start() {
  await loadDb();
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
    await pendingSave;
    process.exit(0);
  });
}
module.exports = { server, start, _db: () => db };
