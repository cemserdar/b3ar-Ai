const AI_DOMAINS = [
  'chatgpt.com', 'claude.ai', 'gemini.google.com', 'google.com',
  'aistudio.google.com', 'deepseek.com', 'kimi.moonshot.cn', 'kimi.com',
  'chatglm.cn', 'z.ai', 'qwen.ai', 'perplexity.ai', 'grok.com', 'mistral.ai', 'poe.com'
];

function toggleTabSelectors(mode) {
  const box = document.getElementById('tabSelectors');
  if (mode === '1') box.classList.add('hidden');
  else box.classList.remove('hidden');
}

async function populateOpenAiTabs(savedArchitectId, savedCoderId) {
  const allTabs = await browser.tabs.query({});
  const aiTabs = allTabs.filter(t => t.url && AI_DOMAINS.some(d => t.url.includes(d)));

  const archSelect = document.getElementById('architectTabSelect');
  const coderSelect = document.getElementById('coderTabSelect');
  archSelect.innerHTML = '';
  coderSelect.innerHTML = '';

  if (aiTabs.length === 0) {
    const opt = '<option value="">Açık AI sekmesi bulunamadı</option>';
    archSelect.innerHTML = opt;
    coderSelect.innerHTML = opt;
    return;
  }

  aiTabs.forEach((tab, idx) => {
    const shortTitle = (tab.title || tab.url).substring(0, 36);
    archSelect.add(new Option(`${idx + 1}. ${shortTitle}`, tab.id));
    coderSelect.add(new Option(`${idx + 1}. ${shortTitle}`, tab.id));
  });

  if (savedArchitectId) archSelect.value = savedArchitectId;
  if (savedCoderId) coderSelect.value = savedCoderId;
  else if (aiTabs.length > 1) coderSelect.selectedIndex = 1;
}

document.addEventListener('DOMContentLoaded', async () => {
  const data = await browser.storage.local.get([
    'wsUrl', 'token', 'autoSend', 'connectionStatus', 'mode', 'architectTabId', 'coderTabId', 'activeWsPort'
  ]);

  const activePort = data.activeWsPort || 8766;
  if (data.wsUrl && !data.wsUrl.includes('127.0.0.1:8765') && !data.wsUrl.includes('127.0.0.1:8766')) {
    document.getElementById('wsUrl').value = data.wsUrl;
  } else {
    document.getElementById('wsUrl').value = `ws://127.0.0.1:${activePort}`;
  }
  if (data.token) document.getElementById('token').value = data.token;
  if (data.autoSend !== undefined) document.getElementById('autoSend').checked = data.autoSend;
  if (data.connectionStatus) document.getElementById('statusText').textContent = `Durum: ${data.connectionStatus}`;

  const currentMode = data.mode || '1';
  document.getElementById('modeSelect').value = currentMode;
  toggleTabSelectors(currentMode);

  await populateOpenAiTabs(data.architectTabId, data.coderTabId);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.connectionStatus) {
      const statusEl = document.getElementById('statusText');
      if (statusEl) {
        statusEl.textContent = `Durum: ${changes.connectionStatus.newValue}`;
      }
    }
  });
});

document.getElementById('modeSelect').addEventListener('change', (e) => {
  toggleTabSelectors(e.target.value);
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const wsUrl = document.getElementById('wsUrl').value.trim() || 'ws://127.0.0.1:8766';
  const token = document.getElementById('token').value.trim() || 'mcp-gizli-anahtar-2026';
  const autoSend = document.getElementById('autoSend').checked;
  const mode = document.getElementById('modeSelect').value;
  const architectTabId = document.getElementById('architectTabSelect').value;
  const coderTabId = document.getElementById('coderTabSelect').value;

  await browser.storage.local.set({ wsUrl, token, autoSend, mode, architectTabId, coderTabId });
  await browser.runtime.sendMessage({ type: 'RECONNECT' });
  document.getElementById('statusText').textContent = 'Durum: Bağlanılıyor...';
});

document.getElementById('startBtn').addEventListener('click', async () => {
  const mode = document.getElementById('modeSelect').value;
  const architectTabId = document.getElementById('architectTabSelect').value;
  const coderTabId = document.getElementById('coderTabSelect').value;

  await browser.storage.local.set({ mode, architectTabId, coderTabId });

  const statusEl = document.getElementById('statusText');
  statusEl.textContent = 'Durum: Akış başlatılıyor...';

  const res = await browser.runtime.sendMessage({ type: 'START_PIPELINE' });
  if (res?.ok) {
    statusEl.textContent = 'Durum: Aktif! Ajanlar çalışıyor.';
    setTimeout(() => window.close(), 800);
  } else {
    statusEl.textContent = `Hata: ${res?.error || 'Sekme seçimi geçersiz'}`;
  }
});
