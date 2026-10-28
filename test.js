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
  assert.equal((await request('GET', '/api/health')).ok, true);
  const admin = (await request('POST', '/api/admin/login', { password: 'test-admin-password' })).token;
  const a = await request('POST', '/api/signup', { username: 'Tester_One', password: 'pass1234' });
  const b = await request('POST', '/api/signup', { username: 'Tester_Two', password: 'pass1234', referralCode: (await request('GET', '/api/me', undefined, a.token)).referralCode });
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
  const ref = await request('GET', '/api/referrals', undefined, a.token);
  assert.equal(ref.rewarded, 1);
  await request('POST', '/api/admin/users/' + b.user.id + '/balance', { amount: 5, note: 'test adjustment' }, admin);
  const generated = await request('POST', '/api/admin/users/' + b.user.id + '/password', { generate: true }, admin);
  assert.ok(generated.temporaryPassword && generated.temporaryPassword.length >= 6);
  const resetLogin = await request('POST', '/api/login', { username: 'Tester_Two', password: generated.temporaryPassword });
  assert.ok(resetLogin.token);
  await request('PUT', '/api/admin/settings', { maintenanceMode: true, maintenanceMessage: 'Back soon' }, admin);
  const cfg = await request('GET', '/api/config');
  assert.equal(cfg.maintenanceMode, true);
  assert.equal(cfg.maintenanceMessage, 'Back soon');
  assert.equal((await request('GET', '/api/products'))[0].inStock, 0);
  const buyRes = await fetch(base + '/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` }, body: JSON.stringify({ productId: product.id }) });
  assert.equal(buyRes.status, 503);
  console.log('PASS: health, admin login, signup/referral, category/product/link, key stock, test top-up, purchase, wallet adjustment, generated password, maintenance mode.');
}
run().catch((e) => { console.error('FAIL:', e.stack || e); process.exitCode = 1; }).finally(() => {
  child.kill('SIGTERM');
  setTimeout(() => { try { fs.unlinkSync(dataFile); } catch {} }, 300);
});
