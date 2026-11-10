'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const required = ['index.html', 'admin.html', 'package.json', 'test.js', 'manifest.json', 'sw.js', 'icon.svg', 'offline.html'];
const missing = required.filter((f) => !fs.existsSync(path.join(__dirname, f)));
if (missing.length) { console.error('Missing project files:', missing.join(', ')); process.exit(1); }
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
if (pkg.scripts.start !== 'node server.js') throw new Error('Unexpected start script');
if (manifest.display !== 'standalone' || !manifest.icons || !manifest.icons.length) throw new Error('PWA manifest is incomplete');
for (const file of ['index.html', 'admin.html']) {
  const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((s) => s.trim());
  if (!scripts.length) throw new Error(file + ': no inline JavaScript found');
  scripts.forEach((script, i) => new vm.Script(script, { filename: file + ':inline-' + (i + 1) }));
  console.log('OK ' + file + ': ' + scripts.length + ' inline script(s) parse');
}
console.log('OK PWA manifest, service worker, icon and offline page');
if (!fs.existsSync(path.join(__dirname, 'server.js'))) console.warn('NOTE: server.js is missing from supplied files; API integration tests and deployment cannot run yet.');
console.log('Preflight checks passed.');
