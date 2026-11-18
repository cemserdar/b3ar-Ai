// OTOMATİK ÜRETİLDİ — düzenlemeyin. Kaynak: src/browser/ · Üretmek için: npm run build
// Web-to-MCP tarayıcı eklentisi — arka plan (Chrome MV3 service worker / Firefox MV3 event page).
// Tek kaynak: build betiği firefox, Firefox-Gecko-MV3 ve [8766,8767,8768,8769,8770,8765] değerlerini doldurur.
const extApi = typeof browser !== 'undefined' ? browser : chrome;
const TARGET = 'firefox';
const CLIENT_NAME = 'Firefox-Gecko-MV3';
const CANDIDATE_PORTS = [8766,8767,8768,8769,8770,8765];
const LOG_PREFIX = `[Web-MCP ${TARGET} Bg]`;

let socket = null;
let isAuthenticated = false;
// Token reddedildiğinde kullanıcı yeni token girip "Kaydet ve Bağlan" diyene kadar yeniden deneme yapılmaz.
let authFailed = false;
const pendingRequests = new Map();
const pendingOutgoingMessages = [];
let currentPortIndex = 0;
let activeWsPort = CANDIDATE_PORTS[0];

const MAX_QUEUED_MESSAGES = 50;
// tools/call kullanıcı onayı (run_command) ve uzun komutlar nedeniyle uzun sürebilir.
const RPC_TIMEOUTS_MS = { 'tools/call': 10 * 60 * 1000, default: 30000 };
const DEFAULT_LIMITS = { maxPromptsPerHour: 60, maxPromptsPerDay: 400, minSecondsBetweenPrompts: 3 };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const AI_DOMAINS = [
  'chatgpt.com', 'claude.ai', 'gemini.google.com', 'google.com',
  'aistudio.google.com', 'deepseek.com', 'kimi.moonshot.cn', 'kimi.com',
  'chatglm.cn', 'z.ai', 'qwen.ai', 'perplexity.ai', 'grok.com', 'mistral.ai', 'poe.com'
];

const isAiUrl = (url) => !!url && AI_DOMAINS.some(d => url.includes(d));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Kalıcı oturum durumu: service worker uykuya girip uyansa da sekme rolleri kaybolmaz.
// ---------------------------------------------------------------------------
const sessionStore = extApi.storage.session || extApi.storage.local;

async function getTabRole(tabId) {
  const { tabRoles = {} } = await sessionStore.get(['tabRoles']);
  return tabRoles[String(tabId)];
}

async function setTabRole(tabId, role) {
  const { tabRoles = {} } = await sessionStore.get(['tabRoles']);
  tabRoles[String(tabId)] = role;
  await sessionStore.set({ tabRoles });
}

extApi.tabs.onRemoved.addListener(async (tabId) => {
  const { tabRoles = {} } = await sessionStore.get(['tabRoles']);
  if (tabRoles[String(tabId)]) {
    delete tabRoles[String(tabId)];
    await sessionStore.set({ tabRoles });
  }
});

// ---------------------------------------------------------------------------
// Bağlantıyı canlı tut: Chrome service worker / Firefox event page uykuya geçmesin.
// ---------------------------------------------------------------------------
extApi.alarms.create('keepAlive', { periodInMinutes: 0.5 });
extApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepAlive') return;
  if (!socket || socket.readyState !== WebSocket.OPEN) connectWebSocket();
  else socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
});
setInterval(() => {
  if (!socket || socket.readyState !== WebSocket.OPEN) connectWebSocket();
}, 5000);

// ---------------------------------------------------------------------------
// WebSocket yardımcıları
// ---------------------------------------------------------------------------
function enqueueOutgoing(msgObj) {
  pendingOutgoingMessages.push(msgObj);
  if (pendingOutgoingMessages.length > MAX_QUEUED_MESSAGES) pendingOutgoingMessages.shift();
}

function sendOrQueueWsMessage(msgObj) {
  if (socket && socket.readyState === WebSocket.OPEN && isAuthenticated) {
    try {
      socket.send(JSON.stringify(msgObj));
      return;
    } catch (e) {
      console.warn(LOG_PREFIX, 'İletim hatası, kuyruğa alınıyor:', e);
    }
  }
  enqueueOutgoing(msgObj);
  connectWebSocket();
}

function notifyVsCode(method, params) {
  sendOrQueueWsMessage({ jsonrpc: '2.0', method, params });
}

function wsSend(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
    return true;
  }
  console.warn(LOG_PREFIX, 'Gönderilemedi, bağlantı kapalı:', obj.method || obj.id);
  return false;
}

function failPendingRequests(reason) {
  for (const [id, pending] of pendingRequests) {
    pendingRequests.delete(id);
    pending.fail(new Error(reason));
  }
}

async function waitForAuth(maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (socket && socket.readyState === WebSocket.OPEN && isAuthenticated) return true;
    await sleep(150);
  }
  return false;
}

// ---------------------------------------------------------------------------
// İstek kotası (hesap güvenliği): AI sekmelerine otomatik gönderim hızını sınırlar.
// Limitler VS Code ayarlarından kimlik doğrulama sırasında gelir.
// ---------------------------------------------------------------------------
let slotChain = Promise.resolve();

function acquireSendSlot() {
  const run = async () => {
    const { limits, sendLog = [] } = await extApi.storage.local.get(['limits', 'sendLog']);
    const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
    const now = Date.now();
    const day = sendLog.filter(t => now - t < DAY_MS);
    const hour = day.filter(t => now - t < HOUR_MS);

    let denied = null;
    if (hour.length >= L.maxPromptsPerHour) denied = `Saatlik otomatik gönderim limiti (${L.maxPromptsPerHour}) doldu`;
    else if (day.length >= L.maxPromptsPerDay) denied = `Günlük otomatik gönderim limiti (${L.maxPromptsPerDay}) doldu`;

    let waitMs = 0;
    if (!denied) {
      const last = day.length ? Math.max(...day) : 0;
      waitMs = Math.max(0, L.minSecondsBetweenPrompts * 1000 - (now - last));
      day.push(now + waitMs);
      await extApi.storage.local.set({ sendLog: day });
    }
    const quota = {
      usedHour: day.filter(t => now - t < HOUR_MS).length,
      limitHour: L.maxPromptsPerHour,
      usedDay: day.length,
      limitDay: L.maxPromptsPerDay
    };
    notifyVsCode('bridge/quota_status', quota);
    if (denied) {
      notifyVsCode('bridge/log', { level: 'warn', text: `⏸️ ${denied}. Mesaj sekmeye yazıldı ama gönderilmedi; limiti ayarlardan (webMcp.limits) değiştirebilirsiniz.` });
      return { ok: false, reason: denied, quota };
    }
    return { ok: true, waitMs, quota };
  };
  const result = slotChain.then(run, run);
  slotChain = result.catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// Sekme yönetimi
// ---------------------------------------------------------------------------
async function injectPromptToTab(tabId, prompt, role = 'solo') {
  await setTabRole(tabId, role);
  await extApi.tabs.update(Number(tabId), { active: true });
  await sleep(500);
  let res;
  try {
    res = await extApi.tabs.sendMessage(Number(tabId), { type: 'INJECT_HANDOFF', prompt });
  } catch (err) {
    throw new Error(`AI sekmesine ulaşılamadı; sayfayı yenileyin (F5). (${err.message})`);
  }
  if (res && res.ok === false) throw new Error(res.error || 'Mesaj AI sekmesine yazılamadı.');
  if (res && res.sent === false && res.reason) throw new Error(`Mesaj sekmeye yazıldı ama gönderilmedi: ${res.reason}`);
}

async function resolveTargetTabId(mode, preferredTabKey) {
  const stored = await extApi.storage.local.get(['architectTabId', 'coderTabId']);

  if (mode !== '1' && stored[preferredTabKey]) {
    try {
      const tab = await extApi.tabs.get(Number(stored[preferredTabKey]));
      if (tab?.id) return tab.id;
    } catch {}
  }

  const [activeTab] = await extApi.tabs.query({ active: true, currentWindow: true });
  if (isAiUrl(activeTab?.url)) return activeTab.id;

  const allTabs = await extApi.tabs.query({});
  const fallbackAiTab = allTabs.find(t => isAiUrl(t.url));
  if (fallbackAiTab?.id) return fallbackAiTab.id;

  throw new Error('Tarayıcıda açık bir AI sekmesi bulunamadı!');
}

async function findNextAvailableAiTab(failedTabId) {
  const aiTabs = (await extApi.tabs.query({})).filter(t => isAiUrl(t.url));
  if (aiTabs.length <= 1) throw new Error('Limit doldu ancak geçiş yapılacak başka açık AI sekmesi bulunamadı!');
  const currentIdx = aiTabs.findIndex(t => t.id === failedTabId);
  return aiTabs[currentIdx === -1 ? 0 : (currentIdx + 1) % aiTabs.length];
}

// ---------------------------------------------------------------------------
// Bağlantı
// ---------------------------------------------------------------------------
function setStatus(connectionStatus) {
  return extApi.storage.local.set({ connectionStatus });
}

async function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const data = await extApi.storage.local.get(['wsUrl', 'token', 'activeWsPort', 'pinnedWorkspace']);
  const pinnedWorkspace = data.pinnedWorkspace || '';
  const customUrl = (data.wsUrl && data.wsUrl.trim()) ? data.wsUrl.trim() : '';
  const token = (data.token && data.token.trim()) ? data.token.trim() : '';
  if (!token) {
    await setStatus('Token gerekli: VS Code panelindeki 🔑 ile kopyalayıp buraya yapıştırın');
    return;
  }
  if (authFailed) return;
  // Bekleme sırasında başka bir çağrı soketi açmış olabilir.
  if (socket) return;

  const isLocalCandidate = !customUrl || customUrl.includes('127.0.0.1') || customUrl.includes('localhost');
  let targetUrl = customUrl;
  if (isLocalCandidate) {
    let preferredPort = data.activeWsPort || CANDIDATE_PORTS[0];
    const m = customUrl.match(/:(\d+)/);
    if (m) preferredPort = parseInt(m[1], 10);
    const candidateList = [preferredPort, ...CANDIDATE_PORTS.filter(p => p !== preferredPort)];
    activeWsPort = candidateList[currentPortIndex % candidateList.length];
    targetUrl = `ws://127.0.0.1:${activeWsPort}`;
  }

  let ws;
  try {
    ws = new WebSocket(targetUrl);
  } catch (e) {
    console.warn(LOG_PREFIX, 'WebSocket oluşturma hatası:', e);
    stepToNextPort(isLocalCandidate);
    return;
  }
  socket = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'auth-' + Date.now(),
      method: 'bridge/authenticate',
      params: { token, client: CLIENT_NAME, port: activeWsPort, expectedWorkspace: pinnedWorkspace || undefined }
    }));
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.id && String(msg.id).startsWith('auth-')) {
      if (!msg.error) {
        isAuthenticated = true;
        currentPortIndex = 0;
        await extApi.storage.local.set({
          connectionStatus: `Bağlı (Port ${activeWsPort}${msg.result?.workspace ? ' · ' + msg.result.workspace : ''})`,
          connectedWorkspace: msg.result?.workspace || '',
          activeWsPort,
          wsUrl: `ws://127.0.0.1:${activeWsPort}`,
          limits: msg.result?.limits || DEFAULT_LIMITS
        });
        while (pendingOutgoingMessages.length > 0) {
          try { ws.send(JSON.stringify(pendingOutgoingMessages.shift())); } catch (err) {
            console.error(LOG_PREFIX, 'Kuyruktaki mesaj gönderilemedi:', err);
          }
        }
      } else if (msg.error.code === -32002) {
        // Bu port başka bir projeye ait; sabitlenmiş projeyi aramaya devam et (onclose bir sonraki porta geçer).
        await setStatus(`"${pinnedWorkspace}" projesi aranıyor...`);
      } else {
        isAuthenticated = false;
        authFailed = true;
        await setStatus('Token Hatalı: VS Code panelindeki 🔑 ile güncel token\'ı kopyalayın');
      }
      return;
    }

    if (msg.method === 'bridge/execute_prompt') {
      try {
        const { prompt, mode = '1' } = msg.params || {};
        if (!prompt) throw new Error('Boş prompt gönderildi.');
        await extApi.storage.local.set({ mode: String(mode) });
        const initialRole = String(mode) === '1' ? 'solo' : 'architect';
        const targetTabId = await resolveTargetTabId(String(mode), 'architectTabId');
        await injectPromptToTab(targetTabId, prompt, initialRole);
        wsSend({ jsonrpc: '2.0', id: msg.id, result: { status: 'dispatched', tabId: targetTabId } });
      } catch (err) {
        wsSend({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } });
      }
      return;
    }

    if (msg.id && pendingRequests.has(msg.id)) {
      const pending = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      pending.settle(msg);
    }
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    const wasAuth = isAuthenticated;
    isAuthenticated = false;
    socket = null;
    failPendingRequests('VS Code bağlantısı koptu.');
    if (authFailed) return;
    if (isLocalCandidate && !wasAuth) {
      stepToNextPort(true);
    } else {
      setStatus('Bağlı Değil');
      setTimeout(connectWebSocket, 2500);
    }
  };

  ws.onerror = () => {
    console.warn(LOG_PREFIX, `Port ${activeWsPort} bağlantı hatası.`);
  };
}

function stepToNextPort(isLocal) {
  if (isLocal) {
    currentPortIndex = (currentPortIndex + 1) % CANDIDATE_PORTS.length;
    setStatus(`VS Code aranıyor (port ${CANDIDATE_PORTS[currentPortIndex]})...`);
    // Tüm portlar denendiyse (VS Code kapalı) daha seyrek dene.
    setTimeout(connectWebSocket, currentPortIndex === 0 ? 3000 : 350);
  } else {
    setStatus('Bağlantı Hatası');
    setTimeout(connectWebSocket, 2500);
  }
}

/**
 * Açık VS Code pencerelerini yoklar (probe): her porta kısa süreli bağlanıp workspace adını alır.
 * Yoklama bağlantısı VS Code'da aktif istemci yapılmaz.
 */
async function scanWorkspaces() {
  const { token } = await extApi.storage.local.get(['token']);
  if (!token) throw new Error('Önce token girin.');
  const probe = (port) => new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(value); } };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => finish(null), 1500);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'probe-' + port, method: 'bridge/authenticate', params: { token, client: CLIENT_NAME, probe: true } }));
    ws.onmessage = (event) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(event.data);
        finish(msg.error ? { port, workspace: null, error: msg.error.message } : { port, workspace: msg.result?.workspace || '?' });
      } catch { finish(null); }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
  });
  const results = await Promise.all(CANDIDATE_PORTS.map(probe));
  return results.filter(Boolean);
}

/**
 * Token'sız kurulum: ilk erişilebilen VS Code penceresinden eşleştirme ister. Kullanıcı VS Code'da
 * "İzin Ver" derse token gelir ve kaydedilir. (Token tüm VS Code pencerelerinde ortaktır.)
 */
let pairingPromise = null;
function pairWithVsCode() {
  if (pairingPromise) return pairingPromise;
  const tryPort = (port) => new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let ws;
    try { ws = new WebSocket(`ws://127.0.0.1:${port}`); } catch { done(null); return; }
    const openTimer = setTimeout(() => { try { ws.close(); } catch {} done(null); }, 1500);
    ws.onopen = () => {
      clearTimeout(openTimer);
      setStatus('VS Code\'da eşleştirme onayı bekleniyor... (VS Code penceresine bakın)');
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'pair-' + Date.now(), method: 'bridge/pair', params: { client: CLIENT_NAME } }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        done(msg.error ? { error: msg.error.message } : { token: msg.result?.token, workspace: msg.result?.workspace });
      } catch { done({ error: 'Geçersiz yanıt' }); }
      try { ws.close(); } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => { clearTimeout(openTimer); done(null); };
  });

  pairingPromise = (async () => {
    try {
      for (const port of CANDIDATE_PORTS) {
        const res = await tryPort(port);
        if (res?.token) {
          await extApi.storage.local.set({ token: res.token });
          await messageHandlers.RECONNECT();
          return { ok: true, workspace: res.workspace };
        }
        if (res?.error) {
          await setStatus(`Eşleştirme: ${res.error}`);
          return { ok: false, error: res.error };
        }
      }
      await setStatus('Eşleştirme: Açık VS Code penceresi bulunamadı (Web-MCP eklentisi kurulu ve açık mı?)');
      return { ok: false, error: 'Açık VS Code penceresi bulunamadı.' };
    } finally {
      pairingPromise = null;
    }
  })();
  return pairingPromise;
}

async function sendRpcRequest(method, params = {}) {
  if (!(socket && socket.readyState === WebSocket.OPEN && isAuthenticated)) {
    connectWebSocket();
    if (!(await waitForAuth())) {
      throw new Error('VS Code WebSocket sunucusuna bağlı değil (VS Code açık mı, token doğru mu?).');
    }
  }
  const timeoutMs = RPC_TIMEOUTS_MS[method] || RPC_TIMEOUTS_MS.default;
  return new Promise((resolve, reject) => {
    const reqId = 'req_' + crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error(`VS Code ${timeoutMs / 1000} sn içinde yanıt vermedi (${method}).`));
    }, timeoutMs);
    pendingRequests.set(reqId, {
      settle: (data) => { clearTimeout(timer); resolve(data); },
      fail: (err) => { clearTimeout(timer); reject(err); }
    });
    if (!wsSend({ jsonrpc: '2.0', id: reqId, method, params })) {
      const pending = pendingRequests.get(reqId);
      pendingRequests.delete(reqId);
      pending?.fail(new Error('VS Code bağlantısı kapalı.'));
    }
  });
}

async function dispatchRoleToTab(tabId, role, mode) {
  const rpcRes = await sendRpcRequest('bridge/get_role_prompt', { role, mode });
  const prompt = rpcRes?.result?.prompt;
  if (!prompt) throw new Error(rpcRes?.error?.message || 'Rol promptu VS Code sunucusundan alınamadı.');
  await injectPromptToTab(tabId, prompt, role);
}

// ---------------------------------------------------------------------------
// Mesajlar (content script / popup). sendResponse + "return true" Chrome ve Firefox'ta çalışır.
// ---------------------------------------------------------------------------
function respondAsync(sendResponse, fn) {
  Promise.resolve()
    .then(fn)
    .then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
  return true;
}

const messageHandlers = {
  RECONNECT: async () => {
    currentPortIndex = 0;
    authFailed = false;
    if (socket) {
      const old = socket;
      socket = null;
      try { old.close(); } catch {}
    }
    isAuthenticated = false;
    connectWebSocket();
    return { ok: true };
  },

  SCAN_WORKSPACES: async () => ({ ok: true, workspaces: await scanWorkspaces() }),

  PAIR: () => pairWithVsCode(),

  // AI'ın normal sohbet cevabını VS Code sohbet paneline aktarır (kuyruk korumalı)
  AI_RESPONSE_TEXT: async (message) => {
    notifyVsCode('bridge/ai_response', { text: message.text, source: message.source || 'Web AI' });
    return { ok: true };
  },

  ATTENTION_REQUIRED: async (message, sender) => {
    notifyVsCode('bridge/attention_required', { reason: message.reason, url: sender?.tab?.url || '' });
    return { ok: true };
  },

  ACQUIRE_SEND_SLOT: () => acquireSendSlot(),

  START_PIPELINE: async () => {
    const { mode = '1', architectTabId, coderTabId } = await extApi.storage.local.get(['mode', 'architectTabId', 'coderTabId']);
    if (mode === '1') {
      await dispatchRoleToTab(await resolveTargetTabId('1', 'architectTabId'), 'solo', '1');
    } else {
      if (!architectTabId || !coderTabId) throw new Error('Lütfen Mimar ve Kodlayıcı sekmelerini seçin.');
      if (architectTabId === coderTabId) throw new Error('Mimar ve Kodlayıcı farklı sekmeler olmalıdır.');
      await dispatchRoleToTab(architectTabId, 'architect', mode);
    }
    return { ok: true };
  },

  PIPELINE_HANDOFF: async (message) => {
    const { mode = '1', architectTabId, coderTabId } = await extApi.storage.local.get(['mode', 'architectTabId', 'coderTabId']);
    if (mode === '1') return { ok: true };
    if (message.targetRole === 'coder' && coderTabId) {
      await dispatchRoleToTab(coderTabId, 'coder', mode);
    } else if (message.targetRole === 'reviewer' && mode === '3' && architectTabId) {
      await dispatchRoleToTab(architectTabId, 'reviewer', mode);
    }
    return { ok: true };
  },

  AUTO_FAILOVER: async (message, sender) => {
    const failedTabId = sender?.tab?.id;
    const { mode = '1', coderTabId } = await extApi.storage.local.get(['mode', 'coderTabId']);
    let currentRole = await getTabRole(failedTabId);
    if (!currentRole) {
      if (mode === '1') currentRole = 'solo';
      else if (String(failedTabId) === String(coderTabId)) currentRole = 'coder';
      else currentRole = 'architect';
    }

    const nextTab = await findNextAvailableAiTab(failedTabId);
    if (currentRole === 'architect' || currentRole === 'reviewer') {
      await extApi.storage.local.set({ architectTabId: String(nextTab.id) });
    } else if (currentRole === 'coder') {
      await extApi.storage.local.set({ coderTabId: String(nextTab.id) });
    }
    notifyVsCode('bridge/failover_notice', { reason: message.reason, nextTabTitle: nextTab.title, role: currentRole });
    await dispatchRoleToTab(nextTab.id, currentRole, mode);
    return { ok: true, nextTabId: nextTab.id };
  },

  EXECUTE_MCP_CALL: (message) =>
    sendRpcRequest('tools/call', { name: message.payload.tool, arguments: message.payload.arguments })
      .catch((err) => ({ result: { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true } }))
};

extApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && messageHandlers[message.type];
  if (!handler) return false;
  return respondAsync(sendResponse, () => handler(message, sender));
});

// İlk kurulumda token yoksa VS Code ile otomatik eşleştir (kopyala-yapıştır gerekmez).
extApi.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  const { token } = await extApi.storage.local.get(['token']);
  if (!token) pairWithVsCode();
});

connectWebSocket();
