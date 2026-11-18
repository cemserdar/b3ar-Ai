'use strict';
// Arka plan tarayıcı yöneticisi: sahte "tarayıcı" betiğiyle gerçek süreç başlatma/durdurma testi (Linux/macOS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installVscodeMock, state } = require('./helpers/vscodeMock');
installVscodeMock();
const { BrowserHost } = require('../lib/browserHost');

const skip = process.platform === 'win32' ? 'Windows\'ta kabuk betiği yok' : false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Argümanlarını dosyaya yazan ve verilen davranışı sergileyen sahte tarayıcı. */
function makeFakeBrowser(dir, behaviour) {
  const exe = path.join(dir, 'fake-chromium');
  const argsFile = path.join(dir, 'args.txt');
  const body = {
    stay: 'exec sleep 30',
    quickExit: 'exit 0',
    crash: 'sleep 0.3; exit 1'
  }[behaviour];
  fs.writeFileSync(exe, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho "DISPLAY=$DISPLAY" >> "${argsFile}"\n${body}\n`, { mode: 0o755 });
  return { exe, argsFile };
}

function makeHost(tmp, states) {
  return new BrowserHost({
    storagePath: path.join(tmp, 'storage'),
    extensionPath: path.join(__dirname, '..'),
    onStateChange: (s) => states.push(s)
  });
}

test('görünür mod: profil 0700, eklenti ve zamanlayıcı bayrakları; durdurma süreci sonlandırır', { skip }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-host-'));
  const { exe, argsFile } = makeFakeBrowser(tmp, 'stay');
  state.config['webMcp.browser.executablePath'] = exe;
  state.config['webMcp.browser.extensionPath'] = path.join(__dirname, '..', '..', 'extension-chrome');
  const states = [];
  const host = makeHost(tmp, states);

  await host.start('visible');
  for (let i = 0; i < 50 && !fs.existsSync(argsFile); i++) await sleep(20);
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.match(args, /--user-data-dir=.*browser-profile/);
  assert.match(args, /--disable-background-timer-throttling/);
  assert.match(args, /--load-extension=.*extension-chrome/);
  assert.match(args, /--restore-last-session/);
  assert.doesNotMatch(args, /--remote-debugging|--headless|--enable-automation/);
  assert.equal(fs.statSync(host.profileDir).mode & 0o777, 0o700);
  assert.equal(host.state, 'visible');

  await host.stop();
  assert.equal(host.isRunning(), false);
  assert.equal(host.state, 'stopped');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('gizli mod: Xvfb yoksa ekran dışı pencereye düşer', { skip: skip || process.platform !== 'linux' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-host-'));
  const { exe, argsFile } = makeFakeBrowser(tmp, 'stay');
  state.config['webMcp.browser.executablePath'] = exe;
  const host = makeHost(tmp, []);
  const savedPath = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath); // Xvfb bulunamasın
  try {
    await host.start('hidden');
    for (let i = 0; i < 50 && !fs.existsSync(argsFile); i++) await sleep(20);
    assert.match(fs.readFileSync(argsFile, 'utf8'), /--window-position=-32000,-32000/);
    assert.equal(host.state, 'hidden');
  } finally {
    process.env.PATH = savedPath;
    await host.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('profil başka süreçte açıksa (hemen 0 ile çıkış) yeniden başlatma döngüsüne girmez', { skip }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-host-'));
  state.config['webMcp.browser.executablePath'] = makeFakeBrowser(tmp, 'quickExit').exe;
  const states = [];
  const host = makeHost(tmp, states);
  await host.start('visible');
  for (let i = 0; i < 100 && host.state !== 'error'; i++) await sleep(20);
  assert.equal(host.state, 'error');
  await sleep(1800);
  assert.equal(states.filter(s => s === 'starting').length, 1, 'tekrar başlatılmamalı');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('çökme: sınırlı sayıda otomatik yeniden başlatma', { skip }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-host-'));
  state.config['webMcp.browser.executablePath'] = makeFakeBrowser(tmp, 'crash').exe;
  const states = [];
  const host = makeHost(tmp, states);
  await host.start('visible');
  // 1 başlangıç + en fazla 3 yeniden başlatma, sonra "error"
  for (let i = 0; i < 400 && host.state !== 'error'; i++) await sleep(25);
  assert.equal(host.state, 'error');
  assert.equal(states.filter(s => s === 'starting').length, 4);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('tarayıcı bulunamazsa anlaşılır hata', async () => {
  state.config['webMcp.browser.executablePath'] = '/olmayan/tarayici';
  const host = makeHost(os.tmpdir(), []);
  await host.start('visible');
  assert.equal(host.state, 'error');
  assert.ok(state.messages.some(([lvl, m]) => lvl === 'error' && /bulunamadı/.test(m)));
});
