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
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_PASSWORD: 'test-admin-password', JWT_SECRET: 'test-secret-that-is-long-enough-for-tests', GATEWAY: 'mock', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' },
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
  assert.match(await sw.text(), /keystore-shell-v3/);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  const admin = (await request('POST', '/api/admin/login', { password: 'test-admin-password' })).token;
  await assert.rejects(() => request('POST', '/api/signup', { username: 'Weak_Pass', password: 'short1' }), /400/);
  const a = await request('POST', '/api/signup', { username: 'Tester_One', password: 'pass1234567' });
  const b = await request('POST', '/api/signup', { username: 'Tester_Two', password: 'pass1234567', referralCode: (await request('GET', '/api/me', undefined, a.token)).referralCode });
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
  await request('PUT', '/api/admin/settings', { maintenanceMode: true, maintenanceMessage: 'Back soon' }, admin);
  const cfg = await request('GET', '/api/config');
  assert.equal(cfg.maintenanceMode, true);
  assert.equal(cfg.maintenanceMessage, 'Back soon');
  assert.equal((await request('GET', '/api/products'))[0].inStock, 0);
  const buyRes = await fetch(base + '/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` }, body: JSON.stringify({ productId: product.id }) });
  assert.equal(buyRes.status, 503);
  await request('POST', '/api/admin/logout-all', {}, admin);
  const revoked = await fetch(base + '/api/admin/stats', { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(revoked.status, 401);
  console.log('PASS: core store + operations, supplier batches, affiliates, SEO, gifts, loyalty, bundles, advanced analytics, community, maintenance mode.');
}
run().catch((e) => { console.error('FAIL:', e.stack || e); process.exitCode = 1; }).finally(() => {
  child.kill('SIGTERM');
  setTimeout(() => { try { fs.unlinkSync(dataFile); } catch {} }, 300);
});
