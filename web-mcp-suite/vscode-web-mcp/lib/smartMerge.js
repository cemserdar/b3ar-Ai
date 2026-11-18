// @ts-check
'use strict';

/**
 * Akıllı birleştirme: AI'ın verdiği fonksiyon/sınıf parçasını dosyadaki aynı isimli bloğun yerine koyar.
 * VS Code API'sine bağımlı değildir (birim test edilebilir).
 */

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return']);

/** @param {string} snippet @returns {string | null} */
function extractSymbolSignature(snippet) {
  const lines = snippet.split('\n').map(l => l.trim()).filter(l =>
    l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('#') && !l.startsWith('[') && !l.startsWith('@')
  );
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  // JS/TS, C#, Java, Python, Go, Rust fonksiyon/metot/sınıf imzaları
  const patterns = [
    /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([a-zA-Z0-9_$]+)\s*\(/,
    /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\()/,
    /(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/,
    /(?:public|private|protected|internal|static|virtual|override|async|\s)+[\w<>[\],\s]+\s+([a-zA-Z0-9_]+)\s*\(/,
    /(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/,
    /func\s+(?:\([^)]+\)\s*)?([a-zA-Z0-9_]+)\s*\(/,
    /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|struct|record|enum)\s+([a-zA-Z0-9_]+)/,
    /^(?:async\s+)?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{/
  ];

  for (const regex of patterns) {
    const match = firstLine.match(regex);
    if (match && match[1] && !KEYWORDS.has(match[1])) return match[1];
  }
  return null;
}

/**
 * Bir satırdaki süslü parantezleri sayar; string ve yorum içindekileri yok sayar.
 * @param {string} line @param {{ inBlockComment: boolean }} state
 */
function countBraces(line, state) {
  let open = 0;
  let close = 0;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === '*' && next === '/') { state.inBlockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === '/' && next === '*') { state.inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') open++;
    else if (ch === '}') close++;
  }
  return { open, close };
}

/** @param {string} str */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} originalContent @param {string} snippet
 * @returns {{ mergedContent: string, matchedSymbol: string } | null}
 */
function tryMergeBySymbol(originalContent, snippet) {
  const symbolName = extractSymbolSignature(snippet);
  if (!symbolName) return null;

  const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = originalContent.replace(/\r\n/g, '\n').split('\n');
  const symbolRegex = new RegExp(`\\b${escapeRegExp(symbolName)}\\s*(\\(|\\{|=|<|:)`);

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
    // Çağrı yerlerini (ör. "foo();") değil, tanımı yakala: satırın imzası da aynı sembolü vermeli.
    if (symbolRegex.test(trimmed) && extractSymbolSignature(trimmed) === symbolName) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;

  const leadingSpaces = lines[startLine].match(/^(\s*)/)[1];
  const isPythonStyle = lines[startLine].trim().endsWith(':') && !lines[startLine].includes('{');
  let endLine = startLine;

  if (isPythonStyle) {
    const baseIndent = leadingSpaces.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      if (l.match(/^(\s*)/)[1].length <= baseIndent) break;
      endLine = i;
    }
  } else {
    let depth = 0;
    let opened = false;
    const state = { inBlockComment: false };
    for (let i = startLine; i < lines.length; i++) {
      const { open, close } = countBraces(lines[i], state);
      if (open > 0) opened = true;
      depth += open - close;
      endLine = i;
      if (opened && depth <= 0) break;
    }
    if (!opened || depth > 0) return null; // Blok sonu bulunamadı: dosyayı bozma riski, birleştirme yapma.
  }

  const snippetLines = snippet.replace(/\r\n/g, '\n').replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const snippetBaseIndent = snippetLines[0].match(/^(\s*)/)[1].length;
  const reindented = snippetLines.map((line, idx) => {
    if (idx === 0) return leadingSpaces + line.trimStart();
    if (line.trim() === '') return '';
    const stripped = line.slice(0, snippetBaseIndent).trim() === '' ? line.slice(snippetBaseIndent) : line.trimStart();
    return leadingSpaces + stripped;
  });

  const merged = [...lines.slice(0, startLine), ...reindented, ...lines.slice(endLine + 1)].join('\n');
  return { mergedContent: eol === '\n' ? merged : merged.replace(/\n/g, eol), matchedSymbol: symbolName };
}

module.exports = { extractSymbolSignature, tryMergeBySymbol, countBraces };
