'use strict';
// Dependency-free smoke/integration tests for the Key Store API.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 18000 + Math.floor(Math.random() * 20000);
const dataFile = path.join(os.tmpdir(), `keystore-test-${process.pid}.json`);
const base = `http://127.0.0.1:${port}`;
const GOOGLE_ID = 'test-client-id.apps.googleusercontent.com';
const stubPort = port + 1;
const googleTokens = {
  'good-token-for-gtest-0001': { iss: 'https://accounts.google.com', aud: GOOGLE_ID, exp: String(Math.floor(Date.now() / 1000) + 3600), email: 'GTest@gmail.com', email_verified: 'true', sub: 'g-sub-1' },
  'wrong-audience-token-0001': { iss: 'https://accounts.google.com', aud: 'someone-else', exp: String(Math.floor(Date.now() / 1000) + 3600), email: 'evil@gmail.com', email_verified: 'true', sub: 'g-sub-2' },
  'unverified-email-token-001': { iss: 'https://accounts.google.com', aud: GOOGLE_ID, exp: String(Math.floor(Date.now() / 1000) + 3600), email: 'unv@gmail.com', email_verified: 'false', sub: 'g-sub-3' },
  'claim-existing-account-001': { iss: 'https://accounts.google.com', aud: GOOGLE_ID, exp: String(Math.floor(Date.now() / 1000) + 3600), email: 'claimme@example.test', email_verified: 'true', sub: 'g-sub-4' },
};
const googleStub = require('node:http').createServer((req, res) => {
  const t = new URL(req.url, 'http://x').searchParams.get('id_token');
  const info = googleTokens[t];
  res.writeHead(info ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(info || { error: 'invalid_token' }));
}).listen(stubPort, '127.0.0.1');
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_PASSWORD: 'test-admin-password', JWT_SECRET: 'test-secret-that-is-long-enough-for-tests', GATEWAY: 'mock', GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${stubPort}/tokeninfo`, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (b) => { logs += b.toString(); });
child.stderr.on('data', (b) => { logs += b.toString(); });

async function request(method, route, body, token) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${data.error || text}`);
  return data;
}
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('Server exited early:\n' + logs);
    try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not start:\n' + logs);
}
async function run() {
  await waitForServer();
  const healthResponse = await fetch(base + '/api/health');
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(healthResponse.headers.get('x-frame-options'), 'DENY');
  assert.equal((await healthResponse.json()).ok, true);
  const sw = await fetch(base + '/sw.js');
  assert.match(await sw.text(), /keystore-shell-v6/);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  const admin = (await request('POST', '/api/admin/login', { password: 'test-admin-password' })).token;
  const consent = { ageConfirmed: true, termsAccepted: true };
  const pw = 'pass1234567';
  await assert.rejects(() => request('POST', '/api/signup', { email: 'weak@example.test', password: 'short1', confirmPassword: 'short1', ...consent }), /400/);
  await assert.rejects(() => request('POST', '/api/signup', { email: 'not-an-email', password: pw, confirmPassword: pw, ...consent }), /valid email/);
  await assert.rejects(() => request('POST', '/api/signup', { email: 'mismatch@example.test', password: pw, confirmPassword: pw + 'x', ...consent }), /do not match/);
  await assert.rejects(() => request('POST', '/api/signup', { email: 'minor@example.test', password: pw, confirmPassword: pw, termsAccepted: true }), /18 or older/);
  await assert.rejects(() => request('POST', '/api/signup', { email: 'noterms@example.test', password: pw, confirmPassword: pw, ageConfirmed: true }), /Terms/);
  const a = await request('POST', '/api/signup', { email: 'Tester_One@example.test', password: pw, confirmPassword: pw, ...consent });
  assert.equal(a.user.email, 'tester_one@example.test');
  assert.equal(a.user.username, 'tester_one');
  await assert.rejects(() => request('POST', '/api/signup', { email: 'TESTER_ONE@example.test', password: pw, confirmPassword: pw, ...consent }), /409/);
  const loginByEmail = await request('POST', '/api/login', { email: 'tester_one@example.test', password: pw });
  assert.equal(loginByEmail.user.id, a.user.id);
  const loginByName = await request('POST', '/api/login', { username: 'Tester_One', password: pw });
  assert.equal(loginByName.user.id, a.user.id);
  await assert.rejects(() => request('POST', '/api/signup', { email: 'x1@example.test', username: 'a b', password: pw, confirmPassword: pw, ...consent }), /Username/);
  await assert.rejects(() => request('POST', '/api/signup', { email: 'x2@example.test', username: 'TESTER_ONE', password: pw, confirmPassword: pw, ...consent }), /409/);
  const named = await request('POST', '/api/signup', { email: 'named@example.test', username: 'My_Name_9', password: pw, confirmPassword: pw, ...consent });
  assert.equal(named.user.username, 'My_Name_9');
  const b = await request('POST', '/api/signup', { email: 'Tester_Two@example.test', password: pw, confirmPassword: pw, ...consent, referralCode: (await request('GET', '/api/me', undefined, a.token)).referralCode });
  // Sign in with Google
  assert.equal((await request('GET', '/api/config')).googleClientId, GOOGLE_ID);
  await assert.rejects(() => request('POST', '/api/auth/google', { credential: 'good-token-for-gtest-0001' }), /CONSENT_REQUIRED/);
  await assert.rejects(() => request('POST', '/api/auth/google', { credential: 'wrong-audience-token-0001', ...consent }), /401/);
  await assert.rejects(() => request('POST', '/api/auth/google', { credential: 'unverified-email-token-001', ...consent }), /401/);
  await assert.rejects(() => request('POST', '/api/auth/google', { credential: 'totally-unknown-token-0001', ...consent }), /401/);
  const g1 = await request('POST', '/api/auth/google', { credential: 'good-token-for-gtest-0001', ...consent });
  assert.equal(g1.user.email, 'gtest@gmail.com');
  const g2 = await request('POST', '/api/auth/google', { credential: 'good-token-for-gtest-0001' });
  assert.equal(g2.user.id, g1.user.id);
  // Google claims an unverified password sign-up for the same email: old password stops working
  const claimed = await request('POST', '/api/signup', { email: 'claimme@example.test', password: pw, confirmPassword: pw, ...consent });
  const g3 = await request('POST', '/api/auth/google', { credential: 'claim-existing-account-001' });
  assert.equal(g3.user.id, claimed.user.id);
  await assert.rejects(() => request('POST', '/api/login', { email: 'claimme@example.test', password: pw }), /401/);
  await assert.rejects(() => request('GET', '/api/me', undefined, claimed.token), /401/);
  const category = await request('POST', '/api/admin/categories', { name: 'Android' }, admin);
  const product = await request('POST', '/api/admin/products', { name: 'Test Key', category: 'Android', description: '1 hour', websiteUrl: 'https://example.com', price: 1 }, admin);
  await request('POST', `/api/admin/products/${product.id}/keys`, { keys: ['KEY-TEST-123'] }, admin);
  const publicProducts = await request('GET', '/api/products');
  assert.equal(publicProducts[0].websiteUrl, 'https://example.com');
  assert.equal(publicProducts[0].category, 'Android');
  const topup = await request('POST', '/api/topup', { amount: 10 }, b.token);
  await request('POST', `/api/payments/${topup.paymentId}/simulate`, {}, b.token);
  const purchase = await request('POST', '/api/buy', { productId: product.id }, b.token);
  assert.equal(purchase.key, 'KEY-TEST-123');
  // 6-digit reference codes for deposits and purchases, searchable by admin
  assert.match(topup.code, /^\d{6}$/);
  assert.match(purchase.code, /^\d{6}$/);
  assert.notEqual(topup.code, purchase.code);
  const foundBuy = await request('GET', '/api/admin/search?q=' + encodeURIComponent('#' + purchase.code), undefined, admin);
  assert.ok(foundBuy.orders.some((o) => o.code === purchase.code));
  const foundPay = await request('GET', '/api/admin/search?q=' + encodeURIComponent('#' + topup.code), undefined, admin);
  assert.ok(foundPay.payments.some((p) => p.code === topup.code));
  assert.equal((await request('GET', '/api/admin/orders?q=' + purchase.code, undefined, admin)).length, 1);
  assert.equal((await request('GET', '/api/admin/payments?q=%23' + topup.code, undefined, admin)).length, 1);
  assert.ok((await request('GET', '/api/orders', undefined, b.token)).some((o) => o.code === purchase.code));
  assert.ok((await request('GET', '/api/wallet', undefined, b.token)).transactions.some((t) => t.note.includes('#' + purchase.code)));
  // many failed buy attempts must never show "Too many attempts"
  for (let i = 0; i < 60; i++) {
    await assert.rejects(() => request('POST', '/api/buy', { productId: product.id }, b.token), (e) => !/429/.test(e.message));
  }
  const idemProduct = await request('POST', '/api/admin/products', { name: 'Idempotency Test', category: 'Android', description: 'Replay test', websiteUrl: 'https://example.com', price: 1 }, admin);
  await request('POST', `/api/admin/products/${idemProduct.id}/keys`, { keys: ['IDEM-KEY-001'] }, admin);
  const idemBody = { productId: idemProduct.id, idem: 'buy-idempotency-001' };
  const idemBuy1 = await request('POST', '/api/buy', idemBody, b.token);
  const idemBuy2 = await request('POST', '/api/buy', idemBody, b.token);
  assert.equal(idemBuy2.orderId, idemBuy1.orderId);
  assert.equal(idemBuy2.key, idemBuy1.key);
  await assert.rejects(() => request('POST', '/api/buy', { productId: idemProduct.id, idem: 'buy-idempotency-001', coupon: 'DIFFERENT' }, b.token), /409/);
  const ref = await request('GET', '/api/referrals', undefined, a.token);
  assert.equal(ref.rewarded, 1);
  await request('POST', '/api/admin/users/' + b.user.id + '/balance', { amount: 5, note: 'test adjustment' }, admin);
  const generated = await request('POST', '/api/admin/users/' + b.user.id + '/password', { generate: true }, admin);
  assert.ok(generated.temporaryPassword && generated.temporaryPassword.length >= 6);
  const resetLogin = await request('POST', '/api/login', { username: 'Tester_Two', password: generated.temporaryPassword });
  assert.ok(resetLogin.token);
  const activeBToken = resetLogin.token;
  // Next-level module integration coverage.
  const supplier = await request('POST', '/api/admin/suppliers', { name: 'Test Distributor', contact: '12345', email: 'supplier@example.test' }, admin);
  const product2 = await request('POST', '/api/admin/products', { name: 'Second Test Key', category: 'Android', description: 'Second test item', websiteUrl: 'https://example.com', price: 1 }, admin);
  await request('POST', '/api/admin/supplier-batches', { supplierId: supplier.id, productId: product.id, unitCost: 0.25, reference: 'INV-001', keys: ['SUPPLIER-KEY-1','SUPPLIER-KEY-2'] }, admin);
  await request('POST', '/api/admin/supplier-batches', { supplierId: supplier.id, productId: product2.id, unitCost: 0.30, reference: 'INV-002', keys: ['SUPPLIER-KEY-3','SUPPLIER-KEY-4'] }, admin);
  assert.ok((await request('GET', '/api/admin/supplier-batches', undefined, admin)).length >= 2);
  const aff = await request('POST', '/api/admin/affiliates', { name: 'Test Affiliate', code: 'TESTAFF', rate: 10 }, admin);
  await request('POST', '/api/affiliate/track/TESTAFF', {});
  await request('POST', '/api/affiliate/apply', { code: 'TESTAFF' }, activeBToken);
  await request('PUT', '/api/admin/loyalty', { earnPer100: 100 }, admin);
  await request('POST', '/api/buy', { productId: product.id }, activeBToken);
  assert.ok((await request('GET', '/api/loyalty/me', undefined, activeBToken)).points > 0);
  const affiliateStats = (await request('GET', '/api/admin/affiliates', undefined, admin))[0];
  assert.ok(affiliateStats.clicks >= 1);
  assert.ok(affiliateStats.conversions >= 1);
  assert.ok(affiliateStats.unpaidPaise >= 1);
  const seo = await request('PUT', '/api/admin/seo/google-play', { title: 'Google Play Gift Cards', description: 'Buy digital gift cards securely online.', canonical: '', noindex: false }, admin);
  assert.equal(seo.title, 'Google Play Gift Cards');
  assert.equal((await request('GET', '/api/seo/google-play')).title, seo.title);
  const seoPage = await fetch(base + '/google-play');
  assert.equal(seoPage.status, 200);
  assert.match(await seoPage.text(), /<title>Google Play Gift Cards<\/title>/);
  const sitemap = await (await fetch(base + '/sitemap.xml')).text();
  assert.match(sitemap, /google-play/);
  const giftPayload = { productId: product2.id, recipient: 'Tester_One', message: 'Enjoy!', idem: 'gift-test-idem-001' };
  const gift = await request('POST', '/api/gifts/buy', giftPayload, activeBToken);
  const giftReplay = await request('POST', '/api/gifts/buy', giftPayload, activeBToken);
  assert.equal(gift.status, 'sent');
  assert.equal(giftReplay.id, gift.id);
  assert.equal((await request('GET', '/api/gifts/received', undefined, a.token)).length, 1);
  const bundle = await request('POST', '/api/admin/bundles', { name: 'Starter Pack', description: 'Two test codes', price: 1.5, items: [{ productId: product.id, quantity: 1 }, { productId: product2.id, quantity: 1 }] }, admin);
  const bundlePayload = { idem: 'bundle-test-idem-001' };
  const bundleBuy = await request('POST', '/api/bundles/' + bundle.id + '/buy', bundlePayload, activeBToken);
  const bundleReplay = await request('POST', '/api/bundles/' + bundle.id + '/buy', bundlePayload, activeBToken);
  assert.equal(bundleBuy.items.length, 2);
  assert.equal(bundleReplay.groupId, bundleBuy.groupId);
  const post = await request('POST', '/api/community', { title: 'Test discussion', body: 'This is a test community post.' }, activeBToken);
  await request('POST', '/api/community/' + post.id + '/reply', { body: 'Thanks for sharing.' }, a.token);
  assert.ok((await request('GET', '/api/community')).length >= 1);
  assert.equal((await request('GET', '/api/admin/operations', undefined, admin)).health, 'operational');
  assert.ok((await request('GET', '/api/admin/analytics/advanced?days=90', undefined, admin)).orders >= 2);
  assert.ok((await request('GET', '/api/admin/community', undefined, admin)).posts.length >= 1);
  assert.ok((await request('GET', '/api/admin/gifts', undefined, admin)).length >= 1);
  // Duration plans (1 Hour / 24 Hours) with per-plan stock and pricing.
  const planProduct = await request('POST', '/api/admin/products', { name: 'Timed Key', category: 'Android', plans: [{ label: '1 Hour', price: 2, mrp: 3 }, { label: '24 Hours', price: 5 }] }, admin);
  const planAdmin = (await request('GET', '/api/admin/products', undefined, admin)).find((x) => x.id === planProduct.id);
  assert.equal(planAdmin.plans.length, 2);
  assert.equal(planAdmin.price, 2);
  const [p1h, p24h] = planAdmin.plans;
  await assert.rejects(() => request('POST', `/api/admin/products/${planProduct.id}/keys`, { keys: ['T-NOPLAN'] }, admin), /400/);
  await request('POST', `/api/admin/products/${planProduct.id}/keys`, { planId: p1h.id, keys: ['T-1H-A', 'T-1H-B', 'T-1H-C'] }, admin);
  await request('POST', `/api/admin/products/${planProduct.id}/generate`, { planId: p24h.id, count: 2 }, admin);
  const pubPlan = (await request('GET', '/api/products')).find((x) => x.id === planProduct.id);
  assert.equal(pubPlan.plans.length, 2);
  assert.equal(pubPlan.plans[0].inStock, 3);
  assert.equal(pubPlan.plans[1].inStock, 2);
  assert.equal(pubPlan.inStock, 5);
  await request('POST', '/api/admin/users/' + b.user.id + '/balance', { amount: 50, note: 'plan test' }, admin);
  await assert.rejects(() => request('POST', '/api/buy', { productId: planProduct.id }, activeBToken), /400/);
  const planBuy = await request('POST', '/api/buy', { productId: planProduct.id, planId: p24h.id }, activeBToken);
  assert.match(planBuy.product, /24 Hours/);
  assert.equal(planBuy.paid, 5);
  const planCheckout = await request('POST', '/api/checkout', { items: [{ productId: planProduct.id, planId: p1h.id, qty: 2 }], idem: 'plan-checkout-001' }, activeBToken);
  assert.equal(planCheckout.items.length, 2);
  assert.equal(planCheckout.paid, 4);
  assert.ok(planCheckout.items.every((i) => /^T-1H-/.test(i.key)));
  const afterPlan = (await request('GET', '/api/products')).find((x) => x.id === planProduct.id);
  assert.equal(afterPlan.plans[0].inStock, 1);
  assert.equal(afterPlan.plans[1].inStock, 1);
  await assert.rejects(() => request('PUT', `/api/admin/products/${planProduct.id}`, { plans: [{ id: p1h.id, label: '1 Hour', price: 2 }] }, admin), /409/);
  await request('PUT', '/api/admin/settings', { maintenanceMode: true, maintenanceMessage: 'Back soon' }, admin);
  const cfg = await request('GET', '/api/config');
  assert.equal(cfg.maintenanceMode, true);
  assert.equal(cfg.maintenanceMessage, 'Back soon');
  assert.equal((await request('GET', '/api/products'))[0].inStock, 0);
  const buyRes = await fetch(base + '/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` }, body: JSON.stringify({ productId: product.id }) });
  assert.equal(buyRes.status, 503);
  // wishlist + Telegram (not configured in tests)
  assert.deepEqual((await request('GET', '/api/wishlist', undefined, a.token)).ids, []);
  assert.deepEqual((await request('POST', '/api/wishlist/' + product.id, { on: true }, a.token)).ids, [product.id]);
  assert.deepEqual((await request('POST', '/api/wishlist/' + product.id, { on: true }, a.token)).ids, [product.id]);
  await assert.rejects(() => request('POST', '/api/wishlist/not-a-product', { on: true }, a.token), /404/);
  assert.deepEqual((await request('POST', '/api/wishlist/' + product.id, { on: false }, a.token)).ids, []);
  await assert.rejects(() => request('GET', '/api/wishlist'), /401/);
  assert.equal((await request('GET', '/api/admin/system', undefined, admin)).telegram, false);
  await assert.rejects(() => request('POST', '/api/admin/telegram/test', {}, admin), /400/);
  await request('POST', '/api/admin/logout-all', {}, admin);
  const revoked = await fetch(base + '/api/admin/stats', { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(revoked.status, 401);
  // Launch cleanup keeps catalog but removes customers and activity
  const adminNow = (await request('POST', '/api/admin/login', { password: 'test-admin-password' })).token;
  await assert.rejects(() => request('POST', '/api/admin/clear-test-data', { confirm: 'yes' }, adminNow), /400/);
  const productsBefore = (await request('GET', '/api/admin/products', undefined, adminNow)).length;
  const cleared = await request('POST', '/api/admin/clear-test-data', { confirm: 'DELETE TEST DATA', restoreKeys: true }, adminNow);
  assert.ok(cleared.cleared.users >= 3 && cleared.keysRestored >= 1);
  assert.equal((await request('GET', '/api/admin/users', undefined, adminNow)).length, 0);
  assert.equal((await request('GET', '/api/admin/orders', undefined, adminNow)).length, 0);
  assert.equal((await request('GET', '/api/admin/products', undefined, adminNow)).length, productsBefore);
  await assert.rejects(() => request('GET', '/api/me', undefined, b.token), /401/);
  const fresh = await request('POST', '/api/signup', { email: 'fresh@example.test', username: 'FreshUser', password: pw, confirmPassword: pw, ...consent });
  assert.equal(fresh.user.username, 'FreshUser');
  console.log('PASS: core store + operations, supplier batches, affiliates, SEO, gifts, loyalty, bundles, advanced analytics, community, maintenance mode, wishlist, Telegram setup check.');
}
run().catch((e) => { console.error('FAIL:', e.stack || e); process.exitCode = 1; }).finally(() => {
  child.kill('SIGTERM'); googleStub.close();
  setTimeout(() => { try { fs.unlinkSync(dataFile); } catch {} }, 300);
});
