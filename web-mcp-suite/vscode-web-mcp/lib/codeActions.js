// @ts-check
'use strict';
const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { resolveSafePath, listWorkspaceFiles } = require('./workspace');
const { mcpTools } = require('./tools');
const { tryMergeBySymbol } = require('./smartMerge');
const { buildAutoPatchPrompt } = require('./prompts');
const ui = require('./ui');

const FILE_COMMENT_REGEX = /^(?:\/\/|#|\/\*|<!--)\s*(?:filepath:|path:|file:)?\s*([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,8})\s*(?:\*\/|-->)?$/i;

/** @param {string} p */
function cleanPath(p) {
  return p.trim().replace(/^\.?\//, '');
}

/** @param {string} relPath */
async function readTarget(relPath) {
  const safe = resolveSafePath(relPath);
  try {
    return { relPath, existed: true, content: await fs.readFile(safe, 'utf-8') };
  } catch {
    return { relPath, existed: false, content: '' };
  }
}

/**
 * AI'ın kod bloğu için hedef dosyayı bulur: açık yol → "// filepath:" yorumu → aktif editör → sembol adı.
 * @param {string} code @param {string | null} [targetPathHint]
 */
async function resolveTargetFileForCode(code, targetPathHint = null) {
  if (typeof targetPathHint === 'string' && targetPathHint.trim()) {
    return readTarget(cleanPath(targetPathHint));
  }

  for (const line of code.trim().split('\n').slice(0, 3)) {
    const m = line.trim().match(FILE_COMMENT_REGEX);
    if (m && m[1]) return readTarget(cleanPath(m[1]));
  }

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    if (!rel.startsWith('.mcp/')) return { relPath: rel, existed: true, content: editor.document.getText() };
  }

  const symbolMatch = code.match(/(?:function|class|const|let|var|def|interface|type)\s+([A-Za-z0-9_]+)/);
  if (symbolMatch && symbolMatch[1]) {
    const sym = symbolMatch[1].toLowerCase();
    const matched = (await listWorkspaceFiles()).find(f => {
      const base = path.basename(f).toLowerCase().split('.')[0];
      return base === sym || base.includes(sym) || sym.includes(base);
    });
    if (matched) return readTarget(matched);
  }
  return null;
}

/** @param {string} placeHolder @param {string} prompt */
async function askPath(prompt, placeHolder = 'src/yeni_dosya.js') {
  const value = await vscode.window.showInputBox({ prompt, placeHolder });
  return value ? value.trim() : null;
}

/** Kod bloğunun tamamını hedef dosyaya yazar. @param {string} code @param {string | null} targetPath */
async function applyCodeToFile(code, targetPath) {
  const target = await resolveTargetFileForCode(code, targetPath);
  const relPath = target?.relPath || await askPath('Hedef dosya yolu otomatik tespit edilemedi. Kaydedilecek yolu girin:');
  if (!relPath) return;
  await mcpTools.write_file({ path: relPath, content: code });
  ui.log(target?.existed ? `📝 '${relPath}' dosyası güncellendi.` : `✨ Yeni dosya oluşturuldu: '${relPath}'`);
}

/** Yeni dosya olarak kaydeder (yol yoksa sorar). @param {string} code @param {string | null} targetPath */
async function saveCodeAsFile(code, targetPath) {
  let relPath = targetPath || (await resolveTargetFileForCode(code, null))?.relPath;
  if (!relPath) relPath = await askPath('Kaydedilecek dosya yolunu girin (Örn: src/utils/yeni.js)');
  if (!relPath) return;
  await mcpTools.write_file({ path: relPath.trim(), content: code });
  ui.log(`✨ Dosya oluşturuldu ve açıldı: ${relPath.trim()}`);
}

/**
 * Akıllı birleştirme: seçim → sembol eşleşmesi → AI'dan apply_diff yaması.
 * @param {string} code @param {string | null} targetPath
 * @param {(method: string, params: object) => Promise<unknown>} sendToBrowser
 */
async function smartMergeCode(code, targetPath, sendToBrowser) {
  const target = await resolveTargetFileForCode(code, targetPath);
  if (!target) throw new Error('Hedef dosya belirlenemedi; lütfen editörde hedef dosyayı açın veya dosya yolunu belirtin.');
  const { relPath, content: fullText } = target;

  if (!target.existed) {
    await mcpTools.write_file({ path: relPath, content: code });
    ui.log(`✨ Yeni dosya oluşturuldu: ${relPath}`);
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && vscode.workspace.asRelativePath(editor.document.uri) === relPath && !editor.selection.isEmpty) {
    const doc = editor.document;
    const merged = fullText.slice(0, doc.offsetAt(editor.selection.start)) + code + fullText.slice(doc.offsetAt(editor.selection.end));
    await mcpTools.write_file({ path: relPath, content: merged });
    ui.log(`🧩 Seçili alan akıllı olarak güncellendi: ${relPath}`);
    return;
  }

  const symbolResult = tryMergeBySymbol(fullText, code);
  if (symbolResult) {
    await mcpTools.write_file({ path: relPath, content: symbolResult.mergedContent });
    ui.log(`🧩 '${symbolResult.matchedSymbol}' bloğu tespit edildi ve dosyayı ezmeden birleştirildi (${relPath}).`);
    return;
  }

  ui.log(`🤖 Doğrudan fonksiyon imzası eşleşmedi; AI'dan '${relPath}' için otomatik diff yaması isteniyor...`);
  await sendToBrowser('bridge/execute_prompt', { prompt: buildAutoPatchPrompt(relPath, fullText, code), mode: '1' });
}

module.exports = { resolveTargetFileForCode, applyCodeToFile, saveCodeAsFile, smartMergeCode };
