const vscode = require('vscode');
const { WebSocketServer } = require('ws');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const CANDIDATE_PORTS = [8766, 8767, 8768, 8765];
let activeWsPort = 8766;
const AUTH_TOKEN = 'mcp-gizli-anahtar-2026';

let wss = null;
let connectedClient = null;
let sidebarView = null;
const pendingBrowserCalls = new Map();
const backupContents = new Map();

const TOOL_MANUAL = `### KULLANABİLECEĞİN MCP ARAÇLARI (XML FORMATI)
Her çağrıya benzersiz bir \`id\` ver (örn: \`req_101\`) ve kod/metin parametrelerini mutlaka \`<![CDATA[ ... ]]>\` içine al.

1. **Dizin Listeleme:**
<mcp_call id="req_01" tool="list_directory">
  <param name="path">.</param>
</mcp_call>

2. **Dosya Okuma:**
<mcp_call id="req_02" tool="read_file">
  <param name="path">src/index.ts</param>
</mcp_call>

3. **Dosya Yazma / Oluşturma:**
<mcp_call id="req_03" tool="write_file">
  <param name="path">src/utils/helper.ts</param>
  <param name="content"><![CDATA[
// tam dosya içeriği
  ]]></param>
</mcp_call>

4. **Kısmi Kod Değişikliği (Diff):**
<mcp_call id="req_04" tool="apply_diff">
  <param name="path">src/utils/helper.ts</param>
  <param name="search"><![CDATA[
// mevcut kod (birebir aynı)
  ]]></param>
  <param name="replace"><![CDATA[
// yeni kod
  ]]></param>
</mcp_call>

5. **Terminal Komutu:**
<mcp_call id="req_05" tool="run_command">
  <param name="command">npm test</param>
</mcp_call>

**KURALLAR:**
- İnternette arama yapma, sadece yukarıdaki XML araçlarını kullan.
- Kod bloklarının içine ASLA \`// ... mevcut kodlar\` gibi kısaltmalar yazma.
- Mevcut içeriğini bilmediğin dosyaya \`apply_diff\` yapma; önce \`read_file\` ile oku.
- Her önemli adımda \`.mcp/STATE.md\` dosyasını güncelle.`;

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('VS Code içinde açık bir proje klasörü yok!');
  }
  return folders[0].uri.fsPath;
}

function resolveSafePath(relativePath) {
  const root = getWorkspaceRoot();
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Güvenlik İhlali: Proje dizini dışına erişim engellendi (${relativePath})`);
  }
  return resolved;
}

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

async function listWorkspaceFiles() {
  const excludePattern = '{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**,**/.next/**,**/dist/**,**/.mcp/**}';
  const uris = await vscode.workspace.findFiles('**/*', excludePattern, 300);
  return uris
    .map(uri => vscode.workspace.asRelativePath(uri))
    .sort((a, b) => a.localeCompare(b));
}

async function openVsCodeDiff(filePath, oldContent) {
  try {
    const tmpDir = path.join(getWorkspaceRoot(), '.mcp', '.tmp_diff');
    await fs.mkdir(tmpDir, { recursive: true });
    const oldTmpFile = path.join(tmpDir, `OLD_${path.basename(filePath)}`);
    await fs.writeFile(oldTmpFile, oldContent, 'utf-8');

    const leftUri = vscode.Uri.file(oldTmpFile);
    const rightUri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      `AI Değişikliği: ${path.basename(filePath)} (Eski ↔ Yeni)`
    );
  } catch (err) {
    console.error('Diff açma hatası:', err);
  }
}

async function finalizeDiffTab(relativePath, openNormalFile = true) {
  const safePath = resolveSafePath(relativePath);
  const targetTitle = `AI Değişikliği: ${path.basename(safePath)} (Eski ↔ Yeni)`;

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.label === targetTitle) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }

  try {
    const tmpFile = path.join(getWorkspaceRoot(), '.mcp', '.tmp_diff', `OLD_${path.basename(safePath)}`);
    await fs.unlink(tmpFile);
  } catch {}

  if (openNormalFile) {
    try {
      const doc = await vscode.workspace.openTextDocument(safePath);
      await vscode.window.showTextDocument(doc);
    } catch {}
  }
}

// ============================================================================
// AKILLI BİRLEŞTİRME (SMART MERGE) MOTORU
// ============================================================================
function extractSymbolSignature(snippet) {
  const lines = snippet.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('#') && !l.startsWith('['));
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  // JS/TS, C#, Java, Python, Go, Rust fonksiyon/metot/sınıf imzalarını yakalar
  const patterns = [
    /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/,
    /(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(/,
    /(?:public|private|protected|internal|static|virtual|override|async|\s)+[\w<>\[\],\s]+\s+([a-zA-Z0-9_]+)\s*\(/,
    /def\s+([a-zA-Z0-9_]+)\s*\(/,
    /func\s+(?:\([^)]+\)\s*)?([a-zA-Z0-9_]+)\s*\(/,
    /(?:export\s+)?(?:class|interface|struct|record)\s+([a-zA-Z0-9_]+)/,
    /^([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/
  ];

  for (const regex of patterns) {
    const match = firstLine.match(regex);
    if (match && match[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) {
      return match[1];
    }
  }
  return null;
}

function tryMergeBySymbol(originalContent, snippet) {
  const symbolName = extractSymbolSignature(snippet);
  if (!symbolName) return null;

  const lines = originalContent.split('\n');
  const symbolRegex = new RegExp(`\\b${symbolName}\\s*(\\(|\\{|\\=|<)`);

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (symbolRegex.test(trimmed)) {
      startLine = i;
      break;
    }
  }

  if (startLine === -1) return null;

  // Orijinal girintiyi (indentation) koru
  const leadingSpaces = lines[startLine].match(/^(\s*)/)[1];
  const isPythonStyle = lines[startLine].trim().endsWith(':') && !lines[startLine].includes('{');

  let endLine = startLine;

  if (isPythonStyle) {
    const baseIndent = leadingSpaces.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      const currentIndent = l.match(/^(\s*)/)[1].length;
      if (currentIndent <= baseIndent) break;
      endLine = i;
    }
  } else {
    // Süslü parantez { } derinliğini sayarak bloğun tam bitişini bul
    let braceDepth = 0;
    let opened = false;
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') { braceDepth++; opened = true; }
        else if (ch === '}') { braceDepth--; }
      }
      endLine = i;
      if (opened && braceDepth <= 0) break;
    }
    if (!opened) return null;
  }

  // Yeni snippet'i orijinal girintiye hizala
  const snippetLines = snippet.replace(/\r\n/g, '\n').trim().split('\n');
  const snippetBaseIndent = snippetLines[0].match(/^(\s*)/)[1].length;
  const reindentedSnippet = snippetLines.map((line, idx) => {
    if (idx === 0) return leadingSpaces + line.trimStart();
    if (line.trim() === '') return '';
    const stripped = line.length >= snippetBaseIndent ? line.slice(snippetBaseIndent) : line.trimStart();
    return leadingSpaces + stripped;
  });

  const mergedLines = [
    ...lines.slice(0, startLine),
    ...reindentedSnippet,
    ...lines.slice(endLine + 1)
  ];

  return {
    mergedContent: mergedLines.join('\n'),
    matchedSymbol: symbolName
  };
}

async function resolveTargetFileForCode(code, targetPathHint = null) {
  // 1. Kullanıcı veya UI tarafından açıkça bir hedef yol iletildiyse onu kullan
  if (targetPathHint && typeof targetPathHint === 'string' && targetPathHint.trim()) {
    const clean = targetPathHint.trim().replace(/^\/|\.\//, '');
    const safe = resolveSafePath(clean);
    let existed = false;
    let content = '';
    try {
      content = await fs.readFile(safe, 'utf-8');
      existed = true;
    } catch {}
    return { relPath: clean, existed, content };
  }

  // 2. Kodun ilk 3 satırındaki dosya yorumunu tara (// filepath: src/..., # path: ...)
  const lines = code.trim().split('\n').slice(0, 3);
  for (const line of lines) {
    const trimmed = line.trim();
    const commentMatch = trimmed.match(/^(?:\/\/|#|\/\*|<!--)\s*(?:filepath:|path:|file:)?\s*([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]{1,8})\s*(?:\*\/|-->)?$/i);
    if (commentMatch && commentMatch[1]) {
      const clean = commentMatch[1].replace(/^\/|\.\//, '');
      const safe = resolveSafePath(clean);
      let existed = false;
      let content = '';
      try {
        content = await fs.readFile(safe, 'utf-8');
        existed = true;
      } catch {}
      return { relPath: clean, existed, content };
    }
  }

  // 3. Aktif editörde açık olan dosya varsa fallback
  if (vscode.window.activeTextEditor) {
    const doc = vscode.window.activeTextEditor.document;
    const rel = vscode.workspace.asRelativePath(doc.uri);
    if (!rel.startsWith('.mcp')) {
      return { relPath: rel, existed: true, content: doc.getText() };
    }
  }

  // 4. Workspace dosyalarıyla sembol / fonksiyon eşleştirmesi yap
  const symbolMatch = code.match(/(?:function|class|const|let|var|def|interface|type)\s+([A-Za-z0-9_]+)/);
  if (symbolMatch && symbolMatch[1]) {
    const sym = symbolMatch[1].toLowerCase();
    const allFiles = await listWorkspaceFiles();
    const matched = allFiles.find(f => {
      const base = path.basename(f).toLowerCase().split('.')[0];
      return base === sym || base.includes(sym) || sym.includes(base);
    });
    if (matched) {
      const safe = resolveSafePath(matched);
      let content = '';
      try {
        content = await fs.readFile(safe, 'utf-8');
      } catch {}
      return { relPath: matched, existed: true, content };
    }
  }

  return null;
}

const mcpTools = {
  async read_file({ path: filePath }) {
    return await fs.readFile(resolveSafePath(filePath), 'utf-8');
  },

  async write_file({ path: filePath, content }) {
    const safePath = resolveSafePath(filePath);
    let oldContent = '';
    let existed = false;
    try {
      oldContent = await fs.readFile(safePath, 'utf-8');
      existed = true;
    } catch {}

    if (!backupContents.has(filePath)) {
      backupContents.set(filePath, { existed, content: oldContent });
    }

    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, 'utf-8');

    if (!filePath.startsWith('.mcp')) {
      await openVsCodeDiff(safePath, oldContent);
      postToWebview({ type: 'FILE_CHANGED', path: filePath, action: existed ? 'Yazıldı' : 'Oluşturuldu' });
    }
    return `SUCCESS: '${filePath}' dosyası yazıldı (${content.length} karakter).`;
  },

  async apply_diff({ path: filePath, search, replace }) {
    const safePath = resolveSafePath(filePath);
    const original = await fs.readFile(safePath, 'utf-8');

    if (!backupContents.has(filePath)) {
      backupContents.set(filePath, { existed: true, content: original });
    }

    const normOriginal = original.replace(/\r\n/g, '\n');
    const normSearch = search.replace(/\r\n/g, '\n').trim();
    const normReplace = replace.replace(/\r\n/g, '\n').trim();

    if (!normOriginal.includes(normSearch)) {
      throw new Error(`DIFF_ERROR: Aranan kod bloğu '${filePath}' içinde bulunamadı. Önce read_file ile okuyun.`);
    }

    const updated = normOriginal.replace(normSearch, normReplace);
    await fs.writeFile(safePath, updated, 'utf-8');

    if (!filePath.startsWith('.mcp')) {
      await openVsCodeDiff(safePath, original);
      postToWebview({ type: 'FILE_CHANGED', path: filePath, action: 'Güncellendi (Diff)' });
    }
    return `SUCCESS: '${filePath}' dosyasına diff yaması uygulandı.`;
  },

  async list_directory({ path: dirPath = '.' }) {
    const entries = await fs.readdir(resolveSafePath(dirPath), { withFileTypes: true });
    const ignored = new Set(['node_modules', '.git', 'bin', 'obj', '.next', 'dist']);
    return entries
      .filter(e => !ignored.has(e.name))
      .map(e => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
      .join('\n');
  },

  async run_command({ command }) {
    postToWebview({ type: 'LOG', text: `⚡ Terminal çalıştırılıyor: ${command}` });
    const { stdout, stderr } = await execAsync(command, { cwd: getWorkspaceRoot(), timeout: 30000 });
    return `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`.trim();
  }
};

function postToWebview(msg) {
  if (sidebarView) {
    sidebarView.webview.postMessage(msg);
  }
}

async function buildSystemSetupPrompt({ role, mode }) {
  const root = getWorkspaceRoot();
  const { state, plan } = await ensureMcpState(root);
  const workspaceFiles = await listWorkspaceFiles();
  const fileTreeSummary = workspaceFiles.slice(0, 150).map(f => `- ${f}`).join('\n');

  let roleInstruction = `Sen VS Code içine gömülü otonom bir Kıdemli Yazılım Mühendisisin. Bundan sonra sana göndereceğim görevleri aşağıdaki MCP araçlarını kullanarak doğrudan proje dosyaları üzerinde uygula.`;

  if (role === 'architect') {
    roleInstruction = `Sen Kıdemli Yazılım Mimarısın. Uygulama kodlarını DEĞİŞTİRME; sadece dosyaları incele, teknik planı \`.mcp/PLAN.md\` dosyasına yaz ve plan bitince yanıtının en altına \`<handoff_to_coder/>\` etiketini koy.`;
  } else if (role === 'coder') {
    const endTag = mode === '3' ? `Bitince yanıtının en altına \`<handoff_to_reviewer/>\` koy.` : `Bitince özet rapor ver.`;
    roleInstruction = `Sen Kıdemli Geliştiricisin. \`.mcp/PLAN.md\` planını ve verilen görevleri koda dök. ${endTag}`;
  } else if (role === 'reviewer') {
    roleInstruction = `Sen Kod Denetçisisin. Yapılan değişiklikleri incele; hata varsa \`.mcp/PLAN.md\` içine yazıp \`<handoff_to_coder/>\` gönder, sorun yoksa onay raporu sun.`;
  }

  return `${roleInstruction}

${TOOL_MANUAL}

---
### MEVCUT PROJE DOSYA AĞACI (İlk 150 Dosya)
${fileTreeSummary || '(Henüz dosya yok veya boş dizin)'}

### OTONOM DOSYA HEDEFLEME & OLUŞTURMA KURALI:
1. **Hedef Dosyayı Kendin Belirle:** Kullanıcının sana dosya yolu vermesini bekleme. Verilen göreve göre (örn: login sayfası, veritabanı modeli, navbar bileşeni) projenin dosya ağacını inceleyerek en uygun dosya yolunu SEN SEÇ.
2. **Otomatik Yeni Dosya / Sayfa Oluştur:** Eğer dosya mevcut değilse doğrudan \`<mcp_call tool="write_file">\` aracını kullanarak dosyayı oluştur. Sistem gerekli tüm alt klasörleri otomatik oluşturacaktır.
3. **Kod Bloğu Başlığı:** Normal metin içinde verdiğin her kod bloğunun ilk satırına hedef dosya yolunu yorum satırı olarak ekle:
   \`// filepath: src/pages/Contact.tsx\` veya \`# filepath: app/models/user.py\`

---
### PROJE HAFIZASI (.mcp/STATE.md)
${state}

### MİMARİ PLAN (.mcp/PLAN.md)
${plan}

Kuralları anladığını kısaca onayla, ben sana görevimi ileteceğim.`;
}

async function buildCleanUserMessage({ userPrompt, includeActiveFile, mentionedFiles = [] }) {
  const attachedFilesMap = new Map();

  for (const relPath of mentionedFiles) {
    try {
      const content = await fs.readFile(resolveSafePath(relPath), 'utf-8');
      attachedFilesMap.set(relPath, content);
    } catch {}
  }

  if (includeActiveFile && vscode.window.activeTextEditor) {
    const doc = vscode.window.activeTextEditor.document;
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    if (!attachedFilesMap.has(relPath) && !relPath.startsWith('.mcp')) {
      attachedFilesMap.set(relPath, doc.getText());
    }
  }

  if (attachedFilesMap.size === 0) {
    return userPrompt;
  }

  let filesContextBlock = '\n\n---\n### EKLENEN DOSYALAR\n';
  for (const [relPath, content] of attachedFilesMap.entries()) {
    filesContextBlock += `\n#### \`${relPath}\`\n\`\`\`\n${content}\n\`\`\`\n`;
  }

  return `${userPrompt}${filesContextBlock}`;
}

function sendToBrowser(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!connectedClient || connectedClient.readyState !== 1) {
      reject(new Error('Tarayıcı eklentisi bağlı değil! Tarayıcıdaki eklenti ikonuna tıklayıp "Ayarları Kaydet ve Bağlan" butonuna basın.'));
      return;
    }
    const id = 'vsc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    pendingBrowserCalls.set(id, resolve);
    connectedClient.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function closeServerCleanly() {
  if (wss) {
    try {
      if (wss.clients) {
        for (const client of wss.clients) {
          try { client.terminate(); } catch {}
        }
      }
      wss.close();
    } catch {}
    wss = null;
    connectedClient = null;
  }
}

function startEmbeddedWebSocketServer(forceRestart = false, portIndex = 0) {
  if (portIndex >= CANDIDATE_PORTS.length) {
    postToWebview({
      type: 'LOG',
      text: `❌ Tüm portlar (${CANDIDATE_PORTS.join(', ')}) meşgul! Lütfen kullanılmayan süreçleri kapatın.`
    });
    return;
  }

  const currentPort = CANDIDATE_PORTS[portIndex];

  if (wss && !forceRestart) return;
  if (wss || forceRestart) {
    closeServerCleanly();
  }

  try {
    const serverInstance = new WebSocketServer({ port: currentPort, host: '127.0.0.1' });

    serverInstance.on('listening', () => {
      wss = serverInstance;
      activeWsPort = currentPort;
      console.log(`[Web-MCP VSC] WebSocket sunucusu aktif: 127.0.0.1:${currentPort}`);
      postToWebview({
        type: 'LOG',
        text: `✅ WebSocket sunucusu (127.0.0.1:${currentPort}) aktif ve dinliyor. Tarayıcı bağlantısı bekleniyor...`
      });
      postToWebview({ type: 'ACTIVE_PORT', port: currentPort });
      postToWebview({ type: 'CONNECTION_STATUS', connected: false, port: currentPort });
    });

    serverInstance.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[Web-MCP VSC] Port ${currentPort} meşgul, sıradaki port deneniyor...`);
        try { serverInstance.close(); } catch {}
        startEmbeddedWebSocketServer(forceRestart, portIndex + 1);
      } else {
        postToWebview({ type: 'LOG', text: `⚠️ Sunucu hatası (${currentPort}): ${err.message}` });
      }
    });

    serverInstance.on('connection', (ws) => {
      let authed = false;

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.method === 'ping') return;

        if (msg.method === 'bridge/authenticate') {
          if (msg.params?.token === AUTH_TOKEN) {
            authed = true;
            connectedClient = ws;
            postToWebview({ type: 'CONNECTION_STATUS', connected: true, client: msg.params?.client || 'Tarayıcı', port: currentPort });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'authenticated', port: currentPort } }));
          } else {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Geçersiz Token' } }));
            ws.close();
          }
          return;
        }

        if (!authed) return;

        if (msg.method === 'bridge/ai_response') {
          const replyText = msg.params?.text;
          if (replyText) {
            postToWebview({
              type: 'AI_REPLY',
              text: replyText,
              source: msg.params?.source || 'AI'
            });
          }
          return;
        }

        if (msg.method === 'bridge/failover_notice') {
          postToWebview({
            type: 'LOG',
            text: `🔄 Auto-Failover: "${msg.params?.reason}" nedeniyle [${msg.params?.nextTabTitle}] sekmesine geçildi.`
          });
          return;
        }

        if (msg.id && pendingBrowserCalls.has(msg.id)) {
          const resolve = pendingBrowserCalls.get(msg.id);
          pendingBrowserCalls.delete(msg.id);
          resolve(msg);
          return;
        }

        if (msg.method === 'bridge/get_role_prompt') {
          const { role = 'solo', mode = '1' } = msg.params || {};
          postToWebview({ type: 'LOG', text: `🔁 Ajan rolü yükleniyor -> ${role.toUpperCase()}` });
          const prompt = await buildSystemSetupPrompt({ role, mode });
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { prompt } }));
          return;
        }

        if (msg.method === 'tools/call') {
          const { name, arguments: args } = msg.params || {};
          postToWebview({ type: 'LOG', text: `⚙️ AI Araç Çalıştırıyor: ${name} (${args?.path || args?.command || ''})` });

          try {
            if (!mcpTools[name]) throw new Error(`Bilinmeyen MCP aracı: ${name}`);
            const output = await mcpTools[name](args || {});
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: output }], isError: false }
            }));
          } catch (err) {
            postToWebview({ type: 'LOG', text: `❌ Hata (${name}): ${err.message}` });
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true }
            }));
          }
        }
      });

      ws.on('close', () => {
        if (connectedClient === ws) {
          connectedClient = null;
          postToWebview({ type: 'CONNECTION_STATUS', connected: false, port: currentPort });
        }
      });
    });
  } catch (err) {
    postToWebview({ type: 'LOG', text: `⚠️ Sunucu başlatılamadı: ${err.message}` });
  }
}

class WebMcpChatProvider {
  resolveWebviewView(webviewView) {
    sidebarView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(__dirname, 'media'))]
    };
    webviewView.webview.html = this.getHtmlContent();

    const pushInitialStatus = () => {
      postToWebview({
        type: 'CONNECTION_STATUS',
        connected: !!(connectedClient && connectedClient.readyState === 1),
        client: connectedClient ? 'Tarayıcı' : undefined,
        port: activeWsPort
      });
      postToWebview({ type: 'ACTIVE_PORT', port: activeWsPort });
    };

    pushInitialStatus();
    setTimeout(pushInitialStatus, 200);
    setTimeout(pushInitialStatus, 600);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      if (data.type === 'REQUEST_CONNECTION_STATUS') {
        pushInitialStatus();
      }

      if (data.type === 'RESTART_SERVER') {
        postToWebview({ type: 'LOG', text: '🔄 WebSocket sunucusu yeniden başlatılıyor...' });
        closeServerCleanly();
        startEmbeddedWebSocketServer(true, 0);
      }

      if (data.type === 'REQUEST_FILES') {
        try {
          const files = await listWorkspaceFiles();
          postToWebview({ type: 'FILES_LIST', files });
        } catch {
          postToWebview({ type: 'FILES_LIST', files: [] });
        }
      }

      if (data.type === 'INIT_AGENT_RULES') {
        try {
          const initialRole = data.mode === '1' ? 'solo' : 'architect';
          const setupPrompt = await buildSystemSetupPrompt({ role: initialRole, mode: data.mode });
          await sendToBrowser('bridge/execute_prompt', { prompt: setupPrompt, mode: data.mode });
          postToWebview({ type: 'LOG', text: '🧠 MCP araç kuralları AI sekmesine yüklendi.' });
        } catch (err) {
          postToWebview({ type: 'LOG', text: `⚠️ ${err.message}` });
        }
      }

      if (data.type === 'SEND_TASK') {
        try {
          const cleanMessage = await buildCleanUserMessage({
            userPrompt: data.prompt,
            includeActiveFile: data.includeActiveFile,
            mentionedFiles: data.mentionedFiles || []
          });

          await sendToBrowser('bridge/execute_prompt', {
            prompt: cleanMessage,
            mode: data.mode
          });
        } catch (err) {
          postToWebview({ type: 'LOG', text: `⚠️ ${err.message}` });
        }
      }

      // 1. Tam Dosya Üzerine Yazma / Hedef Dosyaya Yazma
      if (data.type === 'APPLY_CODE_TO_ACTIVE' || data.type === 'APPLY_CODE_TO_FILE') {
        try {
          const target = await resolveTargetFileForCode(data.code, data.targetPath);
          if (!target) {
            const inputPath = await vscode.window.showInputBox({
              prompt: 'Hedef dosya yolu otomatik tespit edilemedi. Kaydedilecek yolu girin:',
              placeHolder: 'src/yeni_dosya.js'
            });
            if (!inputPath) return;
            await mcpTools.write_file({ path: inputPath.trim(), content: data.code });
            postToWebview({ type: 'LOG', text: `✨ Yeni dosya oluşturuldu: ${inputPath.trim()}` });
            return;
          }

          await mcpTools.write_file({ path: target.relPath, content: data.code });
          postToWebview({
            type: 'LOG',
            text: target.existed
              ? `📝 '${target.relPath}' dosyası güncellendi.`
              : `✨ Yeni dosya oluşturuldu: '${target.relPath}'`
          });
        } catch (err) {
          postToWebview({ type: 'LOG', text: `⚠️ Kod uygulama hatası: ${err.message}` });
        }
      }

      // 2. AKILLI BİRLEŞTİRME (Smart Merge) - Dosya açık olmasa bile diski okur, birleştirir
      if (data.type === 'SMART_MERGE_CODE') {
        try {
          const target = await resolveTargetFileForCode(data.code, data.targetPath);
          if (!target) throw new Error('Hedef dosya belirlenemedi; lütfen editörde hedef dosyayı açın veya dosya yolunu belirtin.');

          const relPath = target.relPath;
          const fullText = target.content;

          // Eğer dosya yeni ise (henüz yoksa), akıllı birleştirme yerine doğrudan oluştur
          if (!target.existed) {
            await mcpTools.write_file({ path: relPath, content: data.code });
            postToWebview({ type: 'LOG', text: `✨ Yeni dosya oluşturuldu: ${relPath}` });
            return;
          }

          // Strateji A: Kullanıcı editörde bu dosyayı açmış ve seçim yapmışsa, seçili alanı değiştir
          if (vscode.window.activeTextEditor && vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri) === relPath && !vscode.window.activeTextEditor.selection.isEmpty) {
            const editor = vscode.window.activeTextEditor;
            const doc = editor.document;
            const before = fullText.slice(0, doc.offsetAt(editor.selection.start));
            const after = fullText.slice(doc.offsetAt(editor.selection.end));
            const merged = before + data.code + after;
            await mcpTools.write_file({ path: relPath, content: merged });
            postToWebview({ type: 'LOG', text: `🧩 Seçili alan akıllı olarak güncellendi: ${relPath}` });
            return;
          }

          // Strateji B: Fonksiyon/Sınıf imzası eşleştirme (AST / Brace Matching)
          const symbolResult = tryMergeBySymbol(fullText, data.code);
          if (symbolResult) {
            await mcpTools.write_file({ path: relPath, content: symbolResult.mergedContent });
            postToWebview({
              type: 'LOG',
              text: `🧩 '${symbolResult.matchedSymbol}' bloğu tespit edildi ve dosyayı ezmeden birleştirildi (${relPath}).`
            });
            return;
          }

          // Strateji C: Eşleşme bulunamazsa AI'dan otomatik apply_diff yaması iste
          postToWebview({
            type: 'LOG',
            text: `🤖 Doğrudan fonksiyon imzası eşleşmedi; AI'dan '${relPath}' için otomatik diff yaması isteniyor...`
          });

          const autoPatchPrompt = `Aşağıdaki kod parçasını mevcut \`${relPath}\` dosyasına dosyayı bozmadan entegre et. Sadece \`<mcp_call tool="apply_diff">\` aracını kullanarak yamayı uygula, başka açıklama yazma.

### MEVCUT DOSYA (\`${relPath}\`)
\`\`\`
${fullText}
\`\`\`

### ENTEGRE EDİLECEK YENİ KOD PARÇASI
\`\`\`
${data.code}
\`\`\``;

          await sendToBrowser('bridge/execute_prompt', { prompt: autoPatchPrompt, mode: '1' });
        } catch (err) {
          postToWebview({ type: 'LOG', text: `⚠️ Akıllı birleştirme hatası: ${err.message}` });
        }
      }

      // 3. OTOMATİK DOSYA OLUŞTURMA & YENİ DOSYA KAYDETME
      if (data.type === 'AUTO_CREATE_FILE' || data.type === 'SAVE_CODE_AS_NEW_FILE') {
        try {
          let targetPath = data.targetPath;
          if (!targetPath) {
            const target = await resolveTargetFileForCode(data.code, null);
            targetPath = target?.relPath;
          }

          if (!targetPath) {
            targetPath = await vscode.window.showInputBox({
              prompt: 'Kaydedilecek dosya yolunu girin (Örn: src/utils/yeni.js)',
              placeHolder: 'src/yeni_dosya.js'
            });
          }

          if (!targetPath) return;
          await mcpTools.write_file({ path: targetPath.trim(), content: data.code });
          postToWebview({ type: 'LOG', text: `✨ Dosya oluşturuldu ve açıldı: ${targetPath.trim()}` });
        } catch (err) {
          postToWebview({ type: 'LOG', text: `⚠️ Dosya oluşturma hatası: ${err.message}` });
        }
      }

      if (data.type === 'ACCEPT_DIFF') {
        try {
          backupContents.delete(data.path);
          await finalizeDiffTab(data.path, true);
          postToWebview({ type: 'DIFF_RESOLVED', path: data.path, status: 'accepted' });
        } catch (err) {
          postToWebview({ type: 'LOG', text: `⚠️ Onay hatası: ${err.message}` });
        }
      }

      if (data.type === 'REJECT_DIFF') {
        try {
          const backup = backupContents.get(data.path);
          const safePath = resolveSafePath(data.path);

          if (backup) {
            if (backup.existed) {
              await fs.writeFile(safePath, backup.content, 'utf-8');
            } else {
              await fs.unlink(safePath);
            }
            backupContents.delete(data.path);
          }
          await finalizeDiffTab(data.path, backup ? backup.existed : false);
          postToWebview({ type: 'DIFF_RESOLVED', path: data.path, status: 'rejected' });
        } catch (err) {
          postToWebview({ type: 'LOG', text: `⚠️ Geri alma hatası: ${err.message}` });
        }
      }
    });

    pushInitialStatus();
  }

  getHtmlContent() {
    const htmlPath = path.join(__dirname, 'media', 'webview.html');
    if (fsSync.existsSync(htmlPath)) {
      return fsSync.readFileSync(htmlPath, 'utf8');
    }
    return `<!DOCTYPE html><html><body><h3>Webview yüklenemedi: media/webview.html bulunamadı</h3></body></html>`;
  }
}

function activate(context) {
  startEmbeddedWebSocketServer();

  const provider = new WebMcpChatProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('webMcpChatView', provider),
    vscode.commands.registerCommand('webMcp.focusChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.web-mcp-sidebar');
    }),
    vscode.commands.registerCommand('webMcp.cleanPorts', () => {
      closeServerCleanly();
      startEmbeddedWebSocketServer(true, 0);
      vscode.window.showInformationMessage('🧹 WebSocket sunucusu yeniden başlatıldı.');
    })
  );
}

function deactivate() {
  closeServerCleanly();
}

module.exports = { activate, deactivate };
