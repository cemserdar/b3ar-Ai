'use strict';
// Duman testi: eklenti gerçek aktivasyon akışıyla (taklit VS Code) hatasız açılıp kapanabiliyor mu?
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installVscodeMock, state } = require('./helpers/vscodeMock');
installVscodeMock();

test('activate → deactivate hatasız; tarayıcı eklentileri depoya senkronlanır', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-act-'));
  state.workspaceRoot = tmp;
  const storage = path.join(tmp, 'global-storage');
  const ext = require('../extension.js');
  const context = {
    subscriptions: [],
    extensionPath: path.join(__dirname, '..'),
    globalStorageUri: { fsPath: storage },
    extension: { packageJSON: require('../package.json') },
    globalState: { _s: {}, get(k) { return this._s[k]; }, async update(k, v) { this._s[k] = v; } },
    secrets: { _v: undefined, async get() { return this._v; }, async store(_k, v) { this._v = v; } }
  };

  await ext.activate(context);
  assert.ok(context.subscriptions.length > 10, 'komutlar ve sağlayıcılar kaydedilmeli');
  assert.ok(context.secrets._v, 'token üretilmeli');

  // onActivate eşzamansız: senkronu bekle
  const chromeManifest = path.join(storage, 'browser-extensions', 'chrome', 'manifest.json');
  for (let i = 0; i < 50 && !fs.existsSync(chromeManifest); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(chromeManifest), 'Chrome eklentisi sabit klasöre kopyalanmalı');
  assert.ok(state.messages.some(([, m]) => /Web-MCP kuruldu/.test(m)), 'ilk kurulumda sihirbaz önerilmeli');

  await ext.deactivate();
  fs.rmSync(tmp, { recursive: true, force: true });
});
