'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSymbolSignature, tryMergeBySymbol } = require('../lib/smartMerge');

test('imza tespiti: farklı diller', () => {
  assert.equal(extractSymbolSignature('export async function load(a) {'), 'load');
  assert.equal(extractSymbolSignature('const handler = async (req) => {'), 'handler');
  assert.equal(extractSymbolSignature('def compute(x):'), 'compute');
  assert.equal(extractSymbolSignature('func (s *Srv) Start(ctx context.Context) error {'), 'Start');
  assert.equal(extractSymbolSignature('pub fn parse(input: &str) -> Ast {'), 'parse');
  assert.equal(extractSymbolSignature('public async Task<int> Save(User u) {'), 'Save');
  assert.equal(extractSymbolSignature('if (x) {'), null);
});

test('fonksiyonu yerinde değiştirir, girintiyi korur', () => {
  const original = 'class A {\n  run() {\n    old();\n  }\n\n  other() {}\n}\n';
  const r = tryMergeBySymbol(original, 'run() {\n  fresh();\n}');
  assert.equal(r.matchedSymbol, 'run');
  assert.equal(r.mergedContent, 'class A {\n  run() {\n    fresh();\n  }\n\n  other() {}\n}\n');
});

test('string ve yorum içindeki süslü parantezler bloğu bozmaz', () => {
  const original = 'function f() {\n  const s = "}";\n  // } yorum\n  return s;\n}\nfunction g() {}\n';
  const r = tryMergeBySymbol(original, 'function f() {\n  return 1;\n}');
  assert.equal(r.mergedContent, 'function f() {\n  return 1;\n}\nfunction g() {}\n');
});

test('çağrı yerini değil tanımı bulur', () => {
  const original = 'init();\nfunction init() {\n  a();\n}\n';
  const r = tryMergeBySymbol(original, 'function init() {\n  b();\n}');
  assert.equal(r.mergedContent, 'init();\nfunction init() {\n  b();\n}\n');
});

test('Python bloğu girintiyle bulunur', () => {
  const original = 'def a():\n    return 1\n\ndef b():\n    return 2\n';
  const r = tryMergeBySymbol(original, 'def a():\n    return 10');
  assert.equal(r.mergedContent, 'def a():\n    return 10\n\ndef b():\n    return 2\n');
});

test('kapanmayan blokta birleştirme yapmaz (dosyayı bozmamak için)', () => {
  assert.equal(tryMergeBySymbol('function f() {\n  a();\n', 'function f() {\n}'), null);
});

test('CRLF korunur', () => {
  const r = tryMergeBySymbol('function f() {\r\n  a();\r\n}\r\n', 'function f() {\n  b();\n}');
  assert.equal(r.mergedContent, 'function f() {\r\n  b();\r\n}\r\n');
});
