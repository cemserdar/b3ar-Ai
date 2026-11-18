// @ts-check
'use strict';
const vscode = require('vscode');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { BLOCKED_PATH_SEGMENTS, WORKSPACE_EXCLUDE_GLOB } = require('./constants');

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('VS Code içinde açık bir proje klasörü yok!');
  }
  return folders[0].uri.fsPath;
}

function getWorkspaceName() {
  try {
    return vscode.workspace.name || path.basename(getWorkspaceRoot());
  } catch {
    return '(klasör yok)';
  }
}

/** @param {string} baseDir @param {string} target */
function isInsideDir(baseDir, target) {
  return target === baseDir || target.startsWith(baseDir + path.sep);
}

/**
 * Yolu workspace'e göre çözer; dışarı çıkışı, sembolik bağlantı kaçışını ve korunan dizinleri engeller.
 * @param {unknown} relativePath
 * @returns {string} mutlak yol
 */
function resolveSafePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Geçersiz dosya yolu.');
  }
  const root = getWorkspaceRoot();
  const resolved = path.resolve(root, relativePath);
  const violation = () => new Error(`Güvenlik İhlali: Proje dizini dışına erişim engellendi (${relativePath})`);

  if (!isInsideDir(root, resolved)) throw violation();

  const segments = path.relative(root, resolved).split(path.sep);
  if (segments.some(seg => BLOCKED_PATH_SEGMENTS.has(seg.toLowerCase()))) {
    throw new Error(`Güvenlik İhlali: Korunan dizine erişim engellendi (${relativePath})`);
  }

  // Var olan en derin üst yolun gerçek konumu workspace içinde olmalı.
  // lstat kullanılır ki kırık (dangling) bağlantılar da yakalansın.
  let probe = resolved;
  for (;;) {
    try { fsSync.lstatSync(probe); break; } catch {
      if (probe === root) break;
      probe = path.dirname(probe);
    }
  }
  let realProbe;
  let realRoot;
  try {
    realRoot = fsSync.realpathSync(root);
    realProbe = fsSync.realpathSync(probe);
  } catch {
    throw violation();
  }
  if (!isInsideDir(realRoot, realProbe)) throw violation();

  return resolved;
}

/**
 * Yolu doğrular ve tek tip anahtara çevirir ("./a.js", "a.js", "src\\a.js" → "a.js" / "src/a.js").
 * @param {unknown} inputPath
 * @returns {{ safePath: string, relKey: string, isInternal: boolean }}
 */
function normalizeWorkspacePath(inputPath) {
  const safePath = resolveSafePath(inputPath);
  const relKey = path.relative(getWorkspaceRoot(), safePath).split(path.sep).join('/') || '.';
  const isInternal = relKey === '.mcp' || relKey.startsWith('.mcp/');
  return { safePath, relKey, isInternal };
}

async function listWorkspaceFiles(limit = 300) {
  const uris = await vscode.workspace.findFiles('**/*', WORKSPACE_EXCLUDE_GLOB, limit);
  return uris
    .map(uri => vscode.workspace.asRelativePath(uri))
    .sort((a, b) => a.localeCompare(b));
}

/** @param {string} root */
async function ensureMcpState(root) {
  const mcpDir = path.join(root, '.mcp');
  const stateFile = path.join(mcpDir, 'STATE.md');
  const planFile = path.join(mcpDir, 'PLAN.md');
  await fs.mkdir(mcpDir, { recursive: true });
  try { await fs.access(stateFile); } catch {
    await fs.writeFile(stateFile, '# PROJE HAFIZASI (.mcp/STATE.md)\n- VS Code eklentisi ile başlatıldı.\n', 'utf-8');
  }
  try { await fs.access(planFile); } catch {
    await fs.writeFile(planFile, '# UYGULAMA PLANI (.mcp/PLAN.md)\n- Plan bekleniyor.\n', 'utf-8');
  }
  return {
    state: await fs.readFile(stateFile, 'utf-8'),
    plan: await fs.readFile(planFile, 'utf-8')
  };
}

module.exports = {
  getWorkspaceRoot,
  getWorkspaceName,
  isInsideDir,
  resolveSafePath,
  normalizeWorkspacePath,
  listWorkspaceFiles,
  ensureMcpState
};
