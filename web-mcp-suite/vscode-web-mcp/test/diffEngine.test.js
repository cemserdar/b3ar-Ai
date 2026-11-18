'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applySearchReplace, matchEol } = require('../lib/diffEngine');

test('birebir eşleşmeyi değiştirir', () => {
  const r = applySearchReplace('a\nb\nc\n', 'b', 'B');
  assert.equal(r.content, 'a\nB\nc\n');
  assert.equal(r.strategy, 'exact');
});

test('yeni koddaki $&, $1, $\' dizilerini özel desen olarak yorumlamaz', () => {
  const original = 'const x = 1;\n';
  const replace = "const x = s.replace(/a/g, '$&$1$\\'');";
  const r = applySearchReplace(original, 'const x = 1;', replace);
  assert.equal(r.content, replace + '\n');
});

test('birden fazla eşleşmede hata verir (yanlış yere yama yapmaz)', () => {
  assert.throws(
    () => applySearchReplace('x();\nx();\n', 'x();', 'y();'),
    (err) => err.code === 'AMBIGUOUS'
  );
});

test('bulunamayınca NOT_FOUND hatası verir', () => {
  assert.throws(() => applySearchReplace('a\n', 'zzz', 'y'), (err) => err.code === 'NOT_FOUND');
});

test('boş search reddedilir', () => {
  assert.throws(() => applySearchReplace('a\n', '   ', 'y'), (err) => err.code === 'EMPTY_SEARCH');
});

test('CRLF dosyanın satır sonlarını korur', () => {
  const r = applySearchReplace('a\r\nb\r\nc\r\n', 'b\nc', 'B\nC');
  assert.equal(r.content, 'a\r\nB\r\nC\r\n');
});

test('CDATA kaynaklı baştaki/sondaki boş satırları yok sayar', () => {
  const r = applySearchReplace('function f() {\n  return 1;\n}\n', '\n  return 1;\n  ', '\n  return 2;\n  ');
  assert.equal(r.content, 'function f() {\n  return 2;\n}\n');
});

test('girinti farkı olan aramayı satır bazında eşleştirir', () => {
  const original = 'class A {\n    run() {\n        go();\n    }\n}\n';
  const r = applySearchReplace(original, 'run() {\n  go();\n}', '    run() {\n        stop();\n    }');
  assert.equal(r.strategy, 'loose-whitespace');
  assert.equal(r.content, 'class A {\n    run() {\n        stop();\n    }\n}\n');
});

test('matchEol: yeni içeriği CRLF referansa uydurur', () => {
  assert.equal(matchEol('a\nb', 'x\r\ny'), 'a\r\nb');
  assert.equal(matchEol('a\r\nb', 'x\ny'), 'a\nb');
});
