// Web-to-MCP tarayıcı eklentisi — ayar penceresi (Chrome & Firefox ortak).
const extApi = typeof browser !== 'undefined' ? browser : chrome;

const AI_DOMAINS = [
  'chatgpt.com', 'claude.ai', 'gemini.google.com', 'google.com',
  'aistudio.google.com', 'deepseek.com', 'kimi.moonshot.cn', 'kimi.com',
  'chatglm.cn', 'z.ai', 'qwen.ai', 'perplexity.ai', 'grok.com', 'mistral.ai', 'poe.com'
];

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $('statusText').textContent = text;
}

function toggleTabSelectors(mode) {
  $('tabSelectors').classList.toggle('hidden', mode === '1');
}

function fillSelect(select, options, placeholder) {
  select.replaceChildren();
  if (options.length === 0) {
    select.add(new Option(placeholder, ''));
    return;
  }
  for (const [label, value] of options) select.add(new Option(label, value));
}

async function populateOpenAiTabs(savedArchitectId, savedCoderId) {
  const aiTabs = (await extApi.tabs.query({})).filter(t => t.url && AI_DOMAINS.some(d => t.url.includes(d)));
  const options = aiTabs.map((tab, idx) => [`${idx + 1}. ${(tab.title || tab.url).substring(0, 36)}`, String(tab.id)]);
  fillSelect($('architectTabSelect'), options, 'Açık AI sekmesi bulunamadı');
  fillSelect($('coderTabSelect'), options, 'Açık AI sekmesi bulunamadı');

  if (savedArchitectId) $('architectTabSelect').value = savedArchitectId;
  if (savedCoderId) $('coderTabSelect').value = savedCoderId;
  else if (aiTabs.length > 1) $('coderTabSelect').selectedIndex = 1;
}

// Seçenek değeri workspace adıdır (port VS Code yeniden açılınca değişebilir).
function addWorkspaceOption(name, port, select = true) {
  const sel = $('workspaceSelect');
  if (![...sel.options].some(o => o.value === name)) sel.add(new Option(port ? `${name} (port ${port})` : name, name));
  if (select) sel.value = name;
}

async function scanWorkspaces() {
  setStatus('Durum: VS Code pencereleri taranıyor...');
  // Taramada kullanılacak token kaydedilmemiş olabilir.
  const token = $('token').value.trim();
  if (token) await extApi.storage.local.set({ token });
  const res = await extApi.runtime.sendMessage({ type: 'SCAN_WORKSPACES' });
  if (!res?.ok) {
    setStatus(`Hata: ${res?.error || 'Tarama başarısız'}`);
    return;
  }
  const sel = $('workspaceSelect');
  const current = sel.value;
  sel.replaceChildren(new Option('Otomatik (ilk bulunan)', ''));
  const valid = res.workspaces.filter(w => w.workspace);
  for (const w of valid) addWorkspaceOption(w.workspace, w.port, false);
  if ([...sel.options].some(o => o.value === current)) sel.value = current;

  const invalid = res.workspaces.length - valid.length;
  if (valid.length === 0) setStatus(invalid ? 'Durum: VS Code bulundu ama token eşleşmedi.' : 'Durum: Açık VS Code penceresi bulunamadı.');
  else setStatus(`Durum: ${valid.length} VS Code penceresi bulundu${invalid ? `, ${invalid} tanesinde token eşleşmedi` : ''}.`);
}

document.addEventListener('DOMContentLoaded', async () => {
  const data = await extApi.storage.local.get([
    'token', 'autoSend', 'connectionStatus', 'mode', 'architectTabId', 'coderTabId',
    'pinnedWorkspace'
  ]);

  if (data.token) $('token').value = data.token;
  if (data.autoSend !== undefined) $('autoSend').checked = data.autoSend;
  if (data.connectionStatus) setStatus(`Durum: ${data.connectionStatus}`);
  if (data.pinnedWorkspace) addWorkspaceOption(data.pinnedWorkspace, null);

  const currentMode = data.mode || '1';
  $('modeSelect').value = currentMode;
  toggleTabSelectors(currentMode);

  await populateOpenAiTabs(data.architectTabId, data.coderTabId);

  extApi.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.connectionStatus) setStatus(`Durum: ${changes.connectionStatus.newValue}`);
  });
});

$('modeSelect').addEventListener('change', (e) => toggleTabSelectors(e.target.value));

$('pairBtn').addEventListener('click', async () => {
  setStatus('Durum: VS Code\'da eşleştirme onayı bekleniyor... (VS Code penceresine bakın)');
  const res = await extApi.runtime.sendMessage({ type: 'PAIR' });
  if (res?.ok) {
    const { token } = await extApi.storage.local.get(['token']);
    $('token').value = token || '';
    setStatus(`Durum: Eşleştirildi${res.workspace ? ' (' + res.workspace + ')' : ''} ✔`);
  } else {
    setStatus(`Hata: ${res?.error || 'Eşleştirme başarısız'}`);
  }
});

$('scanBtn').addEventListener('click', () => {
  scanWorkspaces().catch(err => setStatus(`Hata: ${err.message}`));
});

$('saveBtn').addEventListener('click', async () => {
  const token = $('token').value.trim();
  await extApi.storage.local.set({
    token,
    autoSend: $('autoSend').checked,
    mode: $('modeSelect').value,
    architectTabId: $('architectTabSelect').value,
    coderTabId: $('coderTabSelect').value,
    // Boş = ilk bulunan VS Code penceresi; dolu = yalnızca bu projeye bağlan.
    pinnedWorkspace: $('workspaceSelect').value
  });
  if (!token) {
    setStatus('Durum: Token gerekli (VS Code → 🔑)');
    return;
  }
  setStatus('Durum: Bağlanılıyor...');
  await extApi.runtime.sendMessage({ type: 'RECONNECT' });
});

$('startBtn').addEventListener('click', async () => {
  await extApi.storage.local.set({
    mode: $('modeSelect').value,
    architectTabId: $('architectTabSelect').value,
    coderTabId: $('coderTabSelect').value
  });
  setStatus('Durum: Akış başlatılıyor...');
  const res = await extApi.runtime.sendMessage({ type: 'START_PIPELINE' });
  if (res?.ok) {
    setStatus('Durum: Aktif! Ajanlar çalışıyor.');
    setTimeout(() => window.close(), 800);
  } else {
    setStatus(`Hata: ${res?.error || 'Sekme seçimi geçersiz'}`);
  }
});
