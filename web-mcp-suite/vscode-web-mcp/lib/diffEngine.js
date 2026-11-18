// @ts-check
'use strict';

/**
 * Arama/değiştirme (search/replace) yama motoru.
 * VS Code API'sine bağımlı değildir; birim testleri doğrudan Node ile çalıştırılabilir.
 */

class DiffError extends Error {
  /** @param {'EMPTY_SEARCH' | 'NOT_FOUND' | 'AMBIGUOUS'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'DiffError';
    this.code = code;
  }
}

/** @param {string} text */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** @param {string} text */
function toLf(text) {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Yeni içeriği referans dosyanın satır sonu stiline uydurur (CRLF dosyası LF'e dönüşmesin).
 * @param {string} content @param {string} reference
 */
function matchEol(content, reference) {
  const lf = toLf(content);
  return detectEol(reference) === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

/** @param {string} haystack @param {string} needle */
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Baştaki ve sondaki yalnızca-boşluk satırlarını atar (CDATA blokları genelde bunları ekler),
 * ilk gerçek satırın girintisini korur.
 * @param {string} text
 */
function stripBlankEdges(text) {
  const lines = text.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/**
 * Satır bazında, girinti/sondaki boşluk farklarını yok sayarak eşleşen tek pencereyi bulur.
 * @param {string[]} fileLines @param {string[]} searchLines
 * @returns {number[]} eşleşen başlangıç satırları
 */
function findLooseLineMatches(fileLines, searchLines) {
  const target = searchLines.map(l => l.trim());
  const starts = [];
  for (let i = 0; i + target.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (fileLines[i + j].trim() !== target[j]) { ok = false; break; }
    }
    if (ok) starts.push(i);
  }
  return starts;
}

/**
 * @param {string} original Dosyanın mevcut içeriği
 * @param {string} search Aranacak blok
 * @param {string} replace Yerine konacak blok
 * @returns {{ content: string, strategy: 'exact' | 'loose-whitespace' }}
 */
function applySearchReplace(original, search, replace) {
  if (typeof search !== 'string' || !search.trim()) {
    throw new DiffError('EMPTY_SEARCH', 'DIFF_ERROR: "search" parametresi boş olamaz.');
  }
  const text = toLf(original);
  const s = stripBlankEdges(toLf(search));
  const r = stripBlankEdges(toLf(typeof replace === 'string' ? replace : ''));

  // 1) Birebir eşleşme
  const exactCount = countOccurrences(text, s);
  if (exactCount > 1) {
    throw new DiffError('AMBIGUOUS', `DIFF_ERROR: Aranan blok dosyada ${exactCount} kez geçiyor. Benzersiz olması için daha fazla çevre satır ekleyin.`);
  }
  if (exactCount === 1) {
    const idx = text.indexOf(s);
    // String.replace kullanılmaz: yeni koddaki $&, $1, $' gibi diziler özel desen olarak yorumlanırdı.
    const updated = text.slice(0, idx) + r + text.slice(idx + s.length);
    return { content: matchEol(updated, original), strategy: 'exact' };
  }

  // 2) Girinti / sondaki boşluk farklarını yok sayan satır eşleşmesi
  const fileLines = text.split('\n');
  const searchLines = s.split('\n');
  const starts = findLooseLineMatches(fileLines, searchLines);
  if (starts.length > 1) {
    throw new DiffError('AMBIGUOUS', `DIFF_ERROR: Aranan blok (boşluklar yok sayıldığında) dosyada ${starts.length} kez geçiyor. Daha fazla çevre satır ekleyin.`);
  }
  if (starts.length === 1) {
    const start = starts[0];
    const updatedLines = [
      ...fileLines.slice(0, start),
      ...(r === '' ? [] : r.split('\n')),
      ...fileLines.slice(start + searchLines.length)
    ];
    return { content: matchEol(updatedLines.join('\n'), original), strategy: 'loose-whitespace' };
  }

  throw new DiffError('NOT_FOUND', 'DIFF_ERROR: Aranan kod bloğu dosyada bulunamadı. Önce read_file ile güncel içeriği okuyun.');
}

module.exports = { applySearchReplace, matchEol, detectEol, DiffError };
