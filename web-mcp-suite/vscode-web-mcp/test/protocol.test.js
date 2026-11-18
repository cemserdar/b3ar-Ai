'use strict';
// Paket tutarlılığı: tek kaynaktan üretilen tarayıcı eklentileri güncel mi, protokol sabitleri eşleşiyor mu?
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { build } = require('../../scripts/build-browser');
const { crc32, writeZip } = require('../../scripts/zip');
const { CANDIDATE_PORTS } = require('../lib/constants');
const { version } = require('../package.json');

const SUITE = path.join(__dirname, '..', '..');

test('tarayıcı eklentisi çıktıları src/browser ile güncel (npm run build)', () => {
  assert.deepEqual(build({ check: true }), []);
});

for (const target of ['chrome', 'firefox']) {
  test(`${target}: port listesi, sürüm ve izinler`, () => {
    const dir = path.join(SUITE, `extension-${target}`);
    const bg = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
    const ports = JSON.parse(bg.match(/const CANDIDATE_PORTS = (\[[^\]]*\]);/)[1]);
    assert.deepEqual(ports, CANDIDATE_PORTS);
    assert.ok(!bg.includes('__TARGET__') && !bg.includes('__CANDIDATE_PORTS__'));

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, version);
    assert.ok(manifest.permissions.includes('alarms'));
    assert.ok(!JSON.stringify(manifest).includes('mcp-gizli'));
  });
}

test('Chrome ve Firefox content script birebir aynı', () => {
  assert.equal(
    fs.readFileSync(path.join(SUITE, 'extension-chrome', 'content.js'), 'utf8'),
    fs.readFileSync(path.join(SUITE, 'extension-firefox', 'content.js'), 'utf8')
  );
});

test('zip: CRC32 standart değeri ve geçerli arşiv imzası', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zip-'));
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'merhaba');
  writeZip([{ rel: 'a.txt', full: path.join(tmp, 'a.txt') }], path.join(tmp, 'out.zip'));
  const buf = fs.readFileSync(path.join(tmp, 'out.zip'));
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  fs.rmSync(tmp, { recursive: true, force: true });
});
