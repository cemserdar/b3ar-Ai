// @ts-check
'use strict';
const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { applySearchReplace, matchEol } = require('./diffEngine');
const { getWorkspaceRoot, resolveSafePath, normalizeWorkspacePath } = require('./workspace');
const { confirmCommand } = require('./auth');
const ui = require('./ui');
const {
  COMMAND_TIMEOUT_MS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_READ_CHARS,
  ORIGINAL_SCHEME,
  IGNORED_DIR_NAMES
} = require('./constants');

const execAsync = promisify(exec);

/**
 * relKey → AI değişikliklerinden önceki hal. Reddet bu hale döner; diff'in sol tarafı da budur.
 * @type {Map<string, { existed: boolean, content: string }>}
 */
const backupContents = new Map();
const originalChangeEmitter = new vscode.EventEmitter();

const originalContentProvider = {
  onDidChange: originalChangeEmitter.event,
  /** @param {import('vscode').Uri} uri */
  provideTextDocumentContent(uri) {
    return backupContents.get(uri.path.replace(/^\//, ''))?.content ?? '';
  }
};

/** @param {string} text */
function truncateMiddle(text, max = MAX_TOOL_OUTPUT_CHARS) {
  if (!text || text.length <= max) return text || '';
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n... [${text.length - max} karakter kısaltıldı] ...\n\n${text.slice(-tail)}`;
}

/** @param {string} safePath @param {string} relKey */
async function openDiffView(safePath, relKey) {
  try {
    const originalUri = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: '/' + relKey, query: String(Date.now()) });
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      vscode.Uri.file(safePath),
      `AI Değişikliği: ${relKey} (Orijinal ↔ Yeni)`,
      { preview: false }
    );
  } catch (err) {
    ui.trace.error(`Diff açma hatası: ${err.message}`);
  }
}

/** @param {string} safePath */
async function closeDiffTabs(safePath) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        vscode.TabInputTextDiff && input instanceof vscode.TabInputTextDiff &&
        input.original.scheme === ORIGINAL_SCHEME &&
        input.modified.fsPath === safePath
      ) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
}

/** @param {string} safePath */
async function openFile(safePath) {
  try {
    const doc = await vscode.workspace.openTextDocument(safePath);
    await vscode.window.showTextDocument(doc);
  } catch {}
}

/** @param {string} relKey @param {boolean} existed @param {string} originalContent */
function rememberOriginal(relKey, existed, originalContent) {
  if (!backupContents.has(relKey)) backupContents.set(relKey, { existed, content: originalContent });
}

/** @param {string} safePath @param {string} relKey @param {string} action */
async function announceChange(safePath, relKey, action) {
  await openDiffView(safePath, relKey);
  ui.post({ type: 'FILE_CHANGED', path: relKey, action });
}

const mcpTools = {
  /** @param {{ path: string }} args */
  async read_file({ path: filePath }) {
    const content = await fs.readFile(resolveSafePath(filePath), 'utf-8');
    if (content.length > MAX_READ_CHARS) {
      return `${content.slice(0, MAX_READ_CHARS)}\n\n... [DOSYA KISALTILDI: toplam ${content.length} karakter, ilk ${MAX_READ_CHARS} gösterildi]`;
    }
    return content;
  },

  /** @param {{ path: string, content: string }} args */
  async write_file({ path: filePath, content }) {
    if (typeof content !== 'string') throw new Error('write_file: "content" parametresi zorunludur.');
    const { safePath, relKey, isInternal } = normalizeWorkspacePath(filePath);
    let oldContent = '';
    let existed = false;
    try {
      oldContent = await fs.readFile(safePath, 'utf-8');
      existed = true;
    } catch {}

    rememberOriginal(relKey, existed, oldContent);
    const finalContent = existed ? matchEol(content, oldContent) : content;
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, finalContent, 'utf-8');

    if (!isInternal) await announceChange(safePath, relKey, existed ? 'Yazıldı' : 'Oluşturuldu');
    return `SUCCESS: '${relKey}' dosyası yazıldı (${finalContent.length} karakter).`;
  },

  /** @param {{ path: string, search: string, replace: string }} args */
  async apply_diff({ path: filePath, search, replace }) {
    const { safePath, relKey, isInternal } = normalizeWorkspacePath(filePath);
    const original = await fs.readFile(safePath, 'utf-8');

    let result;
    try {
      result = applySearchReplace(original, search, replace);
    } catch (err) {
      throw new Error(`${err.message} (dosya: '${relKey}')`);
    }

    rememberOriginal(relKey, true, original);
    await fs.writeFile(safePath, result.content, 'utf-8');

    if (!isInternal) await announceChange(safePath, relKey, 'Güncellendi (Diff)');
    const note = result.strategy === 'loose-whitespace' ? ' (girinti farkları yok sayılarak eşleşti)' : '';
    return `SUCCESS: '${relKey}' dosyasına diff yaması uygulandı${note}.`;
  },

  /** @param {{ path?: string }} args */
  async list_directory({ path: dirPath = '.' }) {
    const entries = await fs.readdir(resolveSafePath(dirPath), { withFileTypes: true });
    return entries
      .filter(e => !IGNORED_DIR_NAMES.has(e.name))
      .map(e => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
      .join('\n');
  },

  /** @param {{ command: string }} args */
  async run_command({ command }) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Geçersiz komut.');
    const cwd = getWorkspaceRoot();
    if (!(await confirmCommand(command, cwd))) {
      ui.log(`⛔ Komut kullanıcı tarafından reddedildi: ${command}`, 'warn');
      throw new Error('Kullanıcı bu komutun çalıştırılmasını reddetti.');
    }
    ui.log(`⚡ Terminal çalıştırılıyor: ${command}`);

    let stdout = '';
    let stderr = '';
    let exitInfo = 'EXIT_CODE: 0';
    try {
      ({ stdout, stderr } = await execAsync(command, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }));
    } catch (err) {
      // Sıfır olmayan çıkış kodu (ör. başarısız testler) bir araç hatası değildir; AI'ın çıktıyı görmesi gerekir.
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      if (err.killed || err.signal) {
        exitInfo = `ZAMAN AŞIMI / SONLANDIRILDI (${COMMAND_TIMEOUT_MS / 1000} sn, sinyal: ${err.signal || '-'})`;
      } else if (typeof err.code === 'number') {
        exitInfo = `EXIT_CODE: ${err.code}`;
      } else {
        throw err;
      }
    }
    return `${exitInfo}\nSTDOUT:\n${truncateMiddle(stdout)}\nSTDERR:\n${truncateMiddle(stderr)}`.trim();
  }
};

/**
 * Tarayıcıdan gelen tools/call isteğini çalıştırır ve MCP sonuç biçiminde döner.
 * @param {string} name @param {Record<string, unknown>} args
 */
async function executeTool(name, args) {
  ui.log(`⚙️ AI Araç Çalıştırıyor: ${name} (${args?.path || args?.command || ''})`);
  try {
    if (!Object.prototype.hasOwnProperty.call(mcpTools, name)) throw new Error(`Bilinmeyen MCP aracı: ${name}`);
    const output = await mcpTools[name](args || {});
    return { content: [{ type: 'text', text: output }], isError: false };
  } catch (err) {
    ui.log(`❌ Hata (${name}): ${err.message}`, 'error');
    return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
  }
}

/** @param {string} inputPath */
async function acceptChange(inputPath) {
  const { safePath, relKey } = normalizeWorkspacePath(inputPath);
  await closeDiffTabs(safePath);
  backupContents.delete(relKey);
  await openFile(safePath);
}

/** @param {string} inputPath */
async function rejectChange(inputPath) {
  const { safePath, relKey } = normalizeWorkspacePath(inputPath);
  const backup = backupContents.get(relKey);
  if (backup) {
    if (backup.existed) await fs.writeFile(safePath, backup.content, 'utf-8');
    else await fs.rm(safePath, { force: true });
  }
  await closeDiffTabs(safePath);
  backupContents.delete(relKey);
  if (backup?.existed) await openFile(safePath);
}

module.exports = {
  mcpTools,
  executeTool,
  acceptChange,
  rejectChange,
  originalContentProvider,
  originalChangeEmitter,
  truncateMiddle
};
