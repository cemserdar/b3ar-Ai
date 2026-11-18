'use strict';
// Gerçek WebSocket bağlantılarıyla köprü + araç entegrasyon testi (VS Code taklit edilir).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installVscodeMock, state } = require('./helpers/vscodeMock');
installVscodeMock();

const WebSocket = require('ws');
const auth = require('../lib/auth');
const { BridgeServer } = require('../lib/bridgeServer');
const { executeTool, rejectChange, acceptChange } = require('../lib/tools');

const ctx = { secrets: { _v: undefined, async get() { return this._v; }, async store(_k, v) { this._v = v; } } };
let server;
let token;
let workspace;

function connect(origin = 'chrome-extension://testext') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin });
    const pending = new Map();
    let n = 0;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      ws.emit('rpc', msg);
    });
    ws.call = (method, params) => new Promise((res) => {
      const id = `t${n++}`;
      pending.set(id, res);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

const waitForClose = (ws) => new Promise((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.once('close', r)));

test.before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'webmcp-'));
  state.workspaceRoot = workspace;
  fs.writeFileSync(path.join(workspace, 'app.js'), 'const x = 1;\n');
  token = await auth.loadOrCreateToken(ctx);
  server = new BridgeServer({
    getWorkspaceName: () => 'test-ws',
    getLimits: () => ({ maxPromptsPerHour: 5 }),
    onPairRequest: auth.handlePairRequest,
    requestHandlers: {
      'tools/call': (p) => executeTool(p.name, p.arguments),
      'test/echo': (p) => ({ echo: p.value }),
      'test/fail': () => { throw new Error('beklenen hata'); }
    },
    notificationHandlers: {}
  });
  server.start();
  for (let i = 0; i < 50 && !server.port; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(server.port, 'sunucu başlamalı');
});

test.after(() => {
  server.stop();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('token rastgele ve yeterince uzun', () => {
  assert.ok(token.length >= 32);
  assert.notEqual(token, 'mcp-gizli-anahtar-2026');
});

test('web sayfası origin\'i reddedilir', async () => {
  await assert.rejects(connect('https://evil.example'), /401/);
});

test('yanlış token reddedilir, doğru token kabul edilir ve limitler iletilir', async () => {
  const bad = await connect();
  const r1 = await bad.call('bridge/authenticate', { token: 'yanlis' });
  assert.equal(r1.error.code, -32001);
  await waitForClose(bad);

  const good = await connect('moz-extension://abcd-1234');
  const r2 = await good.call('bridge/authenticate', { token, client: 'Test' });
  assert.equal(r2.result.workspace, 'test-ws');
  assert.equal(r2.result.limits.maxPromptsPerHour, 5);
  assert.equal(server.isConnected, true);
  good.close();
  await waitForClose(good);
});

test('sabitlenmiş farklı proje reddedilir; probe aktif istemci yapmaz', async () => {
  const ws = await connect();
  const r = await ws.call('bridge/authenticate', { token, expectedWorkspace: 'baska-proje' });
  assert.equal(r.error.code, -32002);
  await waitForClose(ws);

  const probe = await connect();
  const p = await probe.call('bridge/authenticate', { token, probe: true });
  assert.equal(p.result.workspace, 'test-ws');
  await waitForClose(probe);
  assert.equal(server.isConnected, false);
});

test('istek işleyicileri: sonuç, hata ve bilinmeyen metot', async () => {
  const ws = await connect();
  await ws.call('bridge/authenticate', { token });
  assert.deepEqual((await ws.call('test/echo', { value: 42 })).result, { echo: 42 });
  assert.match((await ws.call('test/fail', {})).error.message, /beklenen hata/);
  assert.equal((await ws.call('yok/boyle', {})).error.code, -32601);
  ws.close();
  await waitForClose(ws);
});

test('VS Code → tarayıcı isteği: hata yanıtı reject edilir, bağlantı kopunca bekleyen istek düşer', async () => {
  const ws = await connect();
  await ws.call('bridge/authenticate', { token });
  ws.on('rpc', (msg) => {
    if (msg.method === 'bridge/execute_prompt' && msg.params.prompt === 'hata') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'AI sekmesi yok' } }));
    }
  });
  await assert.rejects(server.request('bridge/execute_prompt', { prompt: 'hata' }), /AI sekmesi yok/);

  const pending = server.request('bridge/execute_prompt', { prompt: 'cevapsiz' });
  ws.close();
  await assert.rejects(pending, /koptu/);
});

test('araçlar: yol güvenliği, apply_diff, komut onayı, reddet', async () => {
  const ws = await connect();
  await ws.call('bridge/authenticate', { token });
  const tool = async (name, args) => (await ws.call('tools/call', { name, arguments: args })).result;

  assert.match((await tool('read_file', { path: '../../etc/passwd' })).content[0].text, /Güvenlik İhlali/);
  assert.match((await tool('write_file', { path: '.git/hooks/pre-commit', content: 'x' })).content[0].text, /Korunan dizin/);

  const diff = await tool('apply_diff', { path: './app.js', search: 'const x = 1;', replace: "const y = s.replace(/a/, '$&');" });
  assert.equal(diff.isError, false);
  assert.equal(fs.readFileSync(path.join(workspace, 'app.js'), 'utf8'), "const y = s.replace(/a/, '$&');\n");

  state.warningAnswer = undefined;
  assert.match((await tool('run_command', { command: 'echo nope' })).content[0].text, /reddetti/);
  state.warningAnswer = 'Çalıştır';
  const failing = process.platform === 'win32' ? 'echo out & exit /b 3' : 'echo out; exit 3';
  assert.match((await tool('run_command', { command: failing })).content[0].text, /EXIT_CODE: 3[\s\S]*out/);

  await rejectChange('app.js');
  assert.equal(fs.readFileSync(path.join(workspace, 'app.js'), 'utf8'), 'const x = 1;\n');

  await tool('write_file', { path: 'yeni/b.js', content: 'b' });
  await acceptChange('./yeni/b.js');
  assert.equal(fs.readFileSync(path.join(workspace, 'yeni/b.js'), 'utf8'), 'b');
  ws.close();
  await waitForClose(ws);
});

test('eşleştirme: onaylanınca token verilir, reddedilince verilmez ve bekleme süresi uygulanır', async () => {
  state.infoAnswer = 'İzin Ver';
  const a = await connect('chrome-extension://pairok');
  const ok = await a.call('bridge/pair', { client: 'Chrome-MV3' });
  assert.equal(ok.result.token, token);
  await waitForClose(a);

  state.infoAnswer = undefined;
  const b = await connect('chrome-extension://pairdeny');
  assert.equal((await b.call('bridge/pair', {})).error.code, -32003);
  await waitForClose(b);

  // Reddedilen kaynak hemen tekrar sorarsa VS Code penceresi açılmaz bile.
  state.infoAnswer = 'İzin Ver';
  const before = state.messages.length;
  const c = await connect('chrome-extension://pairdeny');
  assert.equal((await c.call('bridge/pair', {})).error.code, -32003);
  assert.equal(state.messages.length, before);
  await waitForClose(c);
});
