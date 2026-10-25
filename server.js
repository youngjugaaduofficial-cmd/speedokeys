'use strict';
// Key store backend. Zero dependencies: needs only Node.js 20.6 or newer.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set to 1 when behind nginx/Render/etc.
const MOCK_MODE = !RZP_KEY_ID;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const RESERVE_MINUTES = 20;

if (!ADMIN_PASSWORD || !JWT_SECRET) {
  console.error('ADMIN_PASSWORD and JWT_SECRET must be set (see .env.example).');
  process.exit(1);
}
if (!MOCK_MODE && !RZP_KEY_SECRET) {
  console.error('RAZORPAY_KEY_SECRET must be set when RAZORPAY_KEY_ID is set.');
  process.exit(1);
}

// ---------- tiny JSON file store ----------
let db = { products: [], keys: [], orders: [] };
if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
const uid = () => crypto.randomUUID();
const now = () => Date.now();

// ---------- helpers ----------
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signToken(ttlSeconds) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ role: 'admin', exp: Math.floor(now() / 1000) + ttlSeconds }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!safeEqual(parts[2], expected)) return false;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return p.role === 'admin' && p.exp > Math.floor(now() / 1000);
  } catch (_) {
    return false;
  }
}

function releaseExpired() {
  const cutoff = now() - RESERVE_MINUTES * 60 * 1000;
  let changed = false;
  for (const o of db.orders) {
    if (o.status === 'created' && o.createdAt < cutoff) {
      o.status = 'expired';
      const k = db.keys.find((x) => x.id === o.keyId);
      if (k && k.status === 'reserved') {
        k.status = 'available';
        k.orderId = null;
      }
      changed = true;
    }
  }
  if (changed) save();
}

const stock = (productId) => db.keys.filter((k) => k.productId === productId && k.status === 'available').length;

// Marks an order paid and hands over its key. Idempotent.
function finalizeOrder(order, paymentId) {
  if (order.status === 'paid') return order;
  let key = db.keys.find((k) => k.id === order.keyId);
  if (!key || (key.status !== 'reserved' && key.status !== 'sold') || (key.orderId && key.orderId !== order.id)) {
    // reservation was released (expired); try to grab another key
    key = db.keys.find((k) => k.productId === order.productId && k.status === 'available');
  }
  order.paymentId = paymentId;
  order.paidAt = now();
  if (!key) {
    order.status = 'paid_no_stock'; // customer paid but no key: admin must refund or add stock
    save();
    return order;
  }
  key.status = 'sold';
  key.orderId = order.id;
  order.keyId = key.id;
  order.status = 'paid';
  save();
  return order;
}

async function createRazorpayOrder(amountPaise, receipt) {
  const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
  });
  if (!res.ok) throw new Error(`Razorpay error ${res.status}`);
  return res.json();
}

function publicOrder(order) {
  const out = { orderId: order.id, status: order.status };
  if (order.status === 'paid') {
    const k = db.keys.find((x) => x.id === order.keyId);
    out.key = k ? k.value : null;
  }
  return out;
}

// ---------- mini router ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') {
    handler = opts;
    opts = {};
  }
  const names = [];
  const rx = new RegExp(
    '^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$'
  );
  routes.push({ method, rx, names, opts, handler });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // The web app (store + admin panel) is one page served at the root address
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // index.html can sit next to server.js or inside a public/ folder
      const inPublic = path.join(__dirname, 'public', 'index.html');
      const html = fs.readFileSync(fs.existsSync(inPublic) ? inPublic : path.join(__dirname, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end(html);
    }

    let matched = null;
    let params = {};
    let pathMatchedOtherMethod = false;
    for (const r of routes) {
      const m = r.rx.exec(url.pathname);
      if (!m) continue;
      if (r.method !== req.method) {
        pathMatchedOtherMethod = true;
        continue;
      }
      matched = r;
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      break;
    }
    if (!matched) return send(res, pathMatchedOtherMethod ? 405 : 404, { error: 'Not found' });

    if (matched.opts.admin) {
      const h = req.headers['authorization'] || '';
      if (!h.startsWith('Bearer ') || !verifyToken(h.slice(7))) return send(res, 401, { error: 'Unauthorized' });
    }

    const raw = req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readBody(req, 200 * 1024);
    let body = {};
    if (!matched.opts.raw && raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch (_) {
        return send(res, 400, { error: 'Invalid JSON' });
      }
    }
    const ip = TRUST_PROXY
      ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
      : req.socket.remoteAddress;

    const result = await matched.handler({ req, params, query: url.searchParams, body, raw, ip });
    if (result && result.__status) return send(res, result.__status, result.body);
    send(res, 200, result === undefined ? { ok: true } : result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const status = (code, body) => ({ __status: code, body });

// ---------- routes: webhook ----------
route('POST', '/webhooks/razorpay', { raw: true }, ({ req, raw }) => {
  if (!RZP_WEBHOOK_SECRET) fail(404, 'Not found');
  const sig = req.headers['x-razorpay-signature'] || '';
  const expected = crypto.createHmac('sha256', RZP_WEBHOOK_SECRET).update(raw).digest('hex');
  if (!safeEqual(sig, expected)) fail(400, 'Bad signature');
  try {
    const evt = JSON.parse(raw.toString('utf8'));
    if (evt.event === 'payment.captured') {
      const p = evt.payload.payment.entity;
      const order = db.orders.find((o) => o.razorpayOrderId === p.order_id);
      if (order && p.amount === order.amountPaise) finalizeOrder(order, p.id);
    }
  } catch (e) {
    console.error('webhook parse error', e.message);
  }
  return { ok: true };
});

route('GET', '/health', () => ({ ok: true, mockPayments: MOCK_MODE }));

// ---------- routes: public store ----------
route('GET', '/products', () => {
  releaseExpired();
  return db.products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || '',
    price: p.pricePaise / 100,
    inStock: stock(p.id),
  }));
});

route('POST', '/orders', async ({ body }) => {
  releaseExpired();
  const { productId, deviceId } = body;
  if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 100) fail(400, 'deviceId required');
  const product = db.products.find((p) => p.id === productId);
  if (!product) fail(404, 'Product not found');
  const key = db.keys.find((k) => k.productId === product.id && k.status === 'available');
  if (!key) fail(409, 'Out of stock');

  const order = {
    id: uid(),
    productId: product.id,
    amountPaise: product.pricePaise,
    deviceId,
    status: 'created',
    keyId: key.id,
    razorpayOrderId: null,
    paymentId: null,
    createdAt: now(),
    paidAt: null,
  };
  key.status = 'reserved';
  key.orderId = order.id;

  try {
    if (MOCK_MODE) order.razorpayOrderId = 'mock_' + uid();
    else order.razorpayOrderId = (await createRazorpayOrder(order.amountPaise, order.id.slice(0, 40))).id;
  } catch (e) {
    key.status = 'available';
    key.orderId = null;
    save();
    console.error(e.message);
    fail(502, 'Could not start payment');
  }
  db.orders.push(order);
  save();
  return {
    orderId: order.id,
    razorpayOrderId: order.razorpayOrderId,
    razorpayKeyId: MOCK_MODE ? 'mock' : RZP_KEY_ID,
    amountPaise: order.amountPaise,
    currency: 'INR',
    productName: product.name,
    mock: MOCK_MODE,
  };
});

route('POST', '/orders/verify', ({ body }) => {
  const { orderId, deviceId, razorpay_payment_id, razorpay_signature } = body;
  const order = db.orders.find((o) => o.id === orderId);
  if (!order || order.deviceId !== deviceId) fail(404, 'Order not found');
  if (order.status === 'paid') return publicOrder(order);
  if (typeof razorpay_payment_id !== 'string' || typeof razorpay_signature !== 'string') fail(400, 'Missing payment details');
  let valid;
  if (MOCK_MODE) {
    valid = razorpay_signature === 'mock';
  } else {
    const expected = crypto
      .createHmac('sha256', RZP_KEY_SECRET)
      .update(`${order.razorpayOrderId}|${razorpay_payment_id}`)
      .digest('hex');
    valid = safeEqual(razorpay_signature, expected);
  }
  if (!valid) fail(400, 'Payment verification failed');
  finalizeOrder(order, razorpay_payment_id);
  return publicOrder(order);
});

// Lets the app re-fetch a key (e.g. the app was closed mid-payment and the webhook completed it)
route('GET', '/orders/:id', ({ params, query }) => {
  const order = db.orders.find((o) => o.id === params.id);
  if (!order || order.deviceId !== query.get('deviceId')) fail(404, 'Order not found');
  return publicOrder(order);
});

// ---------- routes: admin ----------
const loginAttempts = new Map(); // ip -> {count, since}
route('POST', '/admin/login', ({ body, ip }) => {
  const rec = loginAttempts.get(ip) || { count: 0, since: now() };
  if (now() - rec.since > 15 * 60 * 1000) {
    rec.count = 0;
    rec.since = now();
  }
  if (rec.count >= 10) fail(429, 'Too many attempts. Try later.');
  if (typeof body.password !== 'string' || !safeEqual(body.password, ADMIN_PASSWORD)) {
    rec.count += 1;
    loginAttempts.set(ip, rec);
    fail(401, 'Wrong password');
  }
  loginAttempts.delete(ip);
  return { token: signToken(12 * 60 * 60) };
});

route('GET', '/admin/products', { admin: true }, () => {
  releaseExpired();
  return db.products.map((p) => {
    const ks = db.keys.filter((k) => k.productId === p.id);
    return {
      id: p.id,
      name: p.name,
      description: p.description || '',
      price: p.pricePaise / 100,
      available: ks.filter((k) => k.status === 'available').length,
      reserved: ks.filter((k) => k.status === 'reserved').length,
      sold: ks.filter((k) => k.status === 'sold').length,
    };
  });
});

route('POST', '/admin/products', { admin: true }, ({ body }) => {
  const { name, description, price } = body;
  const rupees = Number(price);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) fail(400, 'Name required');
  if (!Number.isFinite(rupees) || rupees < 1 || rupees > 500000) fail(400, 'Price must be 1 to 500000');
  const p = {
    id: uid(),
    name: name.trim(),
    description: typeof description === 'string' ? description.trim().slice(0, 300) : '',
    pricePaise: Math.round(rupees * 100),
  };
  db.products.push(p);
  save();
  return status(201, { id: p.id });
});

route('DELETE', '/admin/products/:id', { admin: true }, ({ params }) => {
  const p = db.products.find((x) => x.id === params.id);
  if (!p) fail(404, 'Not found');
  if (db.keys.some((k) => k.productId === p.id && k.status === 'reserved')) {
    fail(409, 'A payment is in progress. Try again in a few minutes.');
  }
  db.keys = db.keys.filter((k) => !(k.productId === p.id && k.status === 'available'));
  db.products = db.products.filter((x) => x.id !== p.id);
  save();
  return { ok: true };
});

route('POST', '/admin/products/:id/keys', { admin: true }, ({ params, body }) => {
  const p = db.products.find((x) => x.id === params.id);
  if (!p) fail(404, 'Not found');
  let list = body.keys;
  if (typeof list === 'string') list = list.split(/\r?\n/);
  if (!Array.isArray(list)) fail(400, 'keys required');
  const existing = new Set(db.keys.filter((k) => k.productId === p.id).map((k) => k.value));
  let added = 0;
  let skipped = 0;
  for (const raw of list.slice(0, 5000)) {
    const v = String(raw).trim();
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

// Generates random keys server-side in the format XXXX-XXXX-XXXX-XXXX
route('POST', '/admin/products/:id/generate', { admin: true }, ({ params, body }) => {
  const p = db.products.find((x) => x.id === params.id);
  if (!p) fail(404, 'Not found');
  const count = Math.min(Math.max(parseInt(body.count, 10) || 0, 1), 500);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const existing = new Set(db.keys.filter((k) => k.productId === p.id).map((k) => k.value));
  let made = 0;
  while (made < count) {
    const chars = [...crypto.randomBytes(16)].map((b) => alphabet[b % alphabet.length]);
    const v = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
    if (existing.has(v)) continue;
    existing.add(v);
    db.keys.push({ id: uid(), productId: p.id, value: v, status: 'available', orderId: null, addedAt: now() });
    made++;
  }
  save();
  return { added: made };
});

route('GET', '/admin/products/:id/keys', { admin: true }, ({ params }) => {
  releaseExpired();
  return db.keys
    .filter((k) => k.productId === params.id)
    .map((k) => ({ id: k.id, value: k.value, status: k.status }));
});

route('DELETE', '/admin/keys/:id', { admin: true }, ({ params }) => {
  const k = db.keys.find((x) => x.id === params.id);
  if (!k) fail(404, 'Not found');
  if (k.status !== 'available') fail(409, 'Only unsold keys can be deleted');
  db.keys = db.keys.filter((x) => x.id !== k.id);
  save();
  return { ok: true };
});

route('GET', '/admin/orders', { admin: true }, () => {
  releaseExpired();
  return db.orders
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200)
    .map((o) => {
      const p = db.products.find((x) => x.id === o.productId);
      const k = db.keys.find((x) => x.id === o.keyId);
      return {
        id: o.id,
        product: p ? p.name : '(deleted)',
        amount: o.amountPaise / 100,
        status: o.status,
        paymentId: o.paymentId,
        key: o.status === 'paid' && k ? k.value : null,
        createdAt: o.createdAt,
      };
    });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server on :${PORT} | payments: ${MOCK_MODE ? 'MOCK (testing only)' : 'Razorpay'}`);
  });
}
module.exports = server;
