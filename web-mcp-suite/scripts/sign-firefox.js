#!/usr/bin/env node
// Firefox eklentisini Mozilla'ya "unlisted" (mağazada listelenmeyen, kendi dağıtımınız) olarak imzalatır.
// İmzalı .xpi, Firefox'a tek tıkla KALICI olarak kurulabilir. Ücretsizdir; addons.mozilla.org hesabı gerekir.
//
// 1) https://addons.mozilla.org/developers/addon/api/key/ adresinden API anahtarı alın.
// 2) AMO_JWT_ISSUER=... AMO_JWT_SECRET=... npm run sign:firefox
// 3) npm run package  → imzalı .xpi pakete otomatik eklenir.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { build } = require('./build-browser');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ARTIFACTS = path.join(DIST, 'signed');
const { AMO_JWT_ISSUER, AMO_JWT_SECRET } = process.env;

if (!AMO_JWT_ISSUER || !AMO_JWT_SECRET) {
  console.error('AMO_JWT_ISSUER ve AMO_JWT_SECRET ortam değişkenleri gerekli.\nAnahtar: https://addons.mozilla.org/developers/addon/api/key/');
  process.exit(1);
}

build();
fs.rmSync(ARTIFACTS, { recursive: true, force: true });
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  '--yes', 'web-ext@8', 'sign',
  '--channel=unlisted',
  '--source-dir', path.join(ROOT, 'extension-firefox'),
  '--artifacts-dir', ARTIFACTS,
  '--api-key', AMO_JWT_ISSUER,
  '--api-secret', AMO_JWT_SECRET
], { stdio: 'inherit' });

const xpi = fs.readdirSync(ARTIFACTS).find(f => f.endsWith('.xpi'));
if (!xpi) {
  console.error('İmzalı .xpi bulunamadı.');
  process.exit(1);
}
fs.copyFileSync(path.join(ARTIFACTS, xpi), path.join(DIST, 'firefox-signed.xpi'));
console.log(`✅ İmzalı eklenti: dist/firefox-signed.xpi (${xpi})`);
