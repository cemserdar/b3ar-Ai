let socket = null;
let isAuthenticated = false;
const pendingRequests = new Map();
const tabRoles = new Map();
const pendingOutgoingMessages = [];

const CANDIDATE_PORTS = [8766, 8767, 8768, 8765];
let currentPortIndex = 0;
let activeWsPort = 8766;

const AI_DOMAINS = [
  'chatgpt.com', 'claude.ai', 'gemini.google.com', 'google.com',
  'aistudio.google.com', 'deepseek.com', 'kimi.moonshot.cn', 'kimi.com',
  'chatglm.cn', 'z.ai', 'qwen.ai', 'perplexity.ai', 'grok.com', 'mistral.ai', 'poe.com'
];

function sendOrQueueWsMessage(msgObj) {
  if (socket && socket.readyState === WebSocket.OPEN && isAuthenticated) {
    try {
      socket.send(JSON.stringify(msgObj));
      console.log('[Web-MCP Firefox Bg] WebSocket mesajı iletildi:', msgObj.method);
    } catch (e) {
      console.warn('[Web-MCP Firefox Bg] İletim hatası, kuyruğa alınıyor:', e);
      pendingOutgoingMessages.push(msgObj);
    }
  } else {
    console.log('[Web-MCP Firefox Bg] WebSocket hazır değil, kuyruğa alındı:', msgObj.method);
    pendingOutgoingMessages.push(msgObj);
    connectWebSocket();
  }
}

async function injectPromptToTab(tabId, prompt, role = 'solo') {
  tabRoles.set(Number(tabId), role);
  await browser.tabs.update(Number(tabId), { active: true });
  await new Promise(r => setTimeout(r, 500));
  await browser.tabs.sendMessage(Number(tabId), {
    type: 'INJECT_HANDOFF',
    prompt
  });
}

async function resolveTargetTabId(mode, preferredTabKey) {
  const stored = await browser.storage.local.get(['architectTabId', 'coderTabId']);

  if (mode !== '1' && stored[preferredTabKey]) {
    try {
      const tab = await browser.tabs.get(Number(stored[preferredTabKey]));
      if (tab?.id) return tab.id;
    } catch {}
  }

  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.url && AI_DOMAINS.some(d => activeTab.url.includes(d))) {
    return activeTab.id;
  }

  const allTabs = await browser.tabs.query({});
  const fallbackAiTab = allTabs.find(t => t.url && AI_DOMAINS.some(d => t.url.includes(d)));
  if (fallbackAiTab?.id) return fallbackAiTab.id;

  throw new Error('Tarayıcıda açık bir AI sekmesi bulunamadı!');
}

async function findNextAvailableAiTab(failedTabId) {
  const allTabs = await browser.tabs.query({});
  const aiTabs = allTabs.filter(t => t.url && AI_DOMAINS.some(d => t.url.includes(d)));

  if (aiTabs.length <= 1) {
    throw new Error('Limit doldu ancak geçiş yapılacak başka açık AI sekmesi bulunamadı!');
  }

  const currentIdx = aiTabs.findIndex(t => t.id === failedTabId);
  const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % aiTabs.length;
  return aiTabs[nextIdx];
}

async function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const data = await browser.storage.local.get(['wsUrl', 'token', 'activeWsPort']);
  let customUrl = (data.wsUrl && data.wsUrl.trim()) ? data.wsUrl.trim() : '';
  const token = (data.token && data.token.trim()) ? data.token.trim() : 'mcp-gizli-anahtar-2026';

  const isLocalCandidate = !customUrl ||
    customUrl.includes('127.0.0.1') ||
    customUrl.includes('localhost');

  let targetUrl = customUrl;
  if (isLocalCandidate) {
    let preferredPort = data.activeWsPort || 8766;
    if (customUrl) {
      const m = customUrl.match(/:(\d+)/);
      if (m) preferredPort = parseInt(m[1], 10);
    }
    const candidateList = [preferredPort, ...CANDIDATE_PORTS.filter(p => p !== preferredPort)];
    activeWsPort = candidateList[currentPortIndex % candidateList.length];
    targetUrl = `ws://127.0.0.1:${activeWsPort}`;
  }

  console.log(`[Web-MCP Firefox Bg] WebSocket bağlanıyor: ${targetUrl} (Port: ${activeWsPort})`);

  try {
    socket = new WebSocket(targetUrl);
  } catch (e) {
    console.warn('[Web-MCP Firefox Bg] WebSocket oluşturma hatası:', e);
    stepToNextPort(isLocalCandidate);
    return;
  }

  socket.onopen = () => {
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'auth-' + Date.now(),
      method: 'bridge/authenticate',
      params: { token, client: 'Firefox-Gecko-MV3', port: activeWsPort }
    }));
  };

  socket.onmessage = async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.id && String(data.id).startsWith('auth-')) {
      if (!data.error) {
        isAuthenticated = true;
        console.log(`[Web-MCP Firefox Bg] ✅ VS Code bağlantısı onaylandı! Port: ${activeWsPort}`);
        await browser.storage.local.set({
          connectionStatus: `Bağlı (Port ${activeWsPort})`,
          activeWsPort,
          wsUrl: `ws://127.0.0.1:${activeWsPort}`
        });

        // Bekleyen kuyruktaki mesajları ilet
        console.log(`[Web-MCP Firefox Bg] Bekleyen kuyruk boşaltılıyor (${pendingOutgoingMessages.length} mesaj)...`);
        while (pendingOutgoingMessages.length > 0) {
          const queued = pendingOutgoingMessages.shift();
          try {
            socket.send(JSON.stringify(queued));
          } catch (err) {
            console.error('[Web-MCP Firefox Bg] Kuyruktaki mesaj gönderilemedi:', err);
          }
        }
      } else {
        isAuthenticated = false;
        await browser.storage.local.set({ connectionStatus: 'Token Hatalı' });
      }
      return;
    }

    if (data.method === 'bridge/execute_prompt') {
      try {
        const { prompt, mode = '1' } = data.params || {};
        if (!prompt) throw new Error('Boş prompt gönderildi.');

        await browser.storage.local.set({ mode: String(mode) });
        const initialRole = String(mode) === '1' ? 'solo' : 'architect';
        const targetTabId = await resolveTargetTabId(String(mode), 'architectTabId');
        await injectPromptToTab(targetTabId, prompt, initialRole);

        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: data.id,
          result: { status: 'dispatched', tabId: targetTabId }
        }));
      } catch (err) {
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: data.id,
          error: { code: -32000, message: err.message }
        }));
      }
      return;
    }

    if (data.id && pendingRequests.has(data.id)) {
      const resolve = pendingRequests.get(data.id);
      pendingRequests.delete(data.id);
      resolve(data);
    }
  };

  socket.onclose = (ev) => {
    const wasAuth = isAuthenticated;
    isAuthenticated = false;
    socket = null;

    if (isLocalCandidate && !wasAuth) {
      stepToNextPort(true);
    } else {
      browser.storage.local.set({ connectionStatus: 'Bağlı Değil' });
      setTimeout(connectWebSocket, 2500);
    }
  };

  socket.onerror = (err) => {
    console.warn(`[Web-MCP Firefox Bg] Port ${activeWsPort} hata verdi:`, err);
  };
}

function stepToNextPort(isLocal) {
  if (isLocal) {
    currentPortIndex = (currentPortIndex + 1) % CANDIDATE_PORTS.length;
    const nextPort = CANDIDATE_PORTS[currentPortIndex];
    browser.storage.local.set({ connectionStatus: `Port ${nextPort} taranıyor...` });
    setTimeout(connectWebSocket, 350);
  } else {
    browser.storage.local.set({ connectionStatus: 'Bağlantı Hatası' });
    setTimeout(connectWebSocket, 2500);
  }
}

function sendRpcRequest(method, params = {}) {
  return new Promise(async (resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
      await connectWebSocket();
      await new Promise(r => setTimeout(r, 600));
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
      reject(new Error('VS Code WebSocket sunucusuna bağlı değil.'));
      return;
    }
    const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    pendingRequests.set(reqId, resolve);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }));
  });
}

async function dispatchRoleToTab(tabId, role, mode) {
  const rpcRes = await sendRpcRequest('bridge/get_role_prompt', { role, mode });
  const prompt = rpcRes?.result?.prompt;
  if (!prompt) throw new Error('Rol promptu VS Code sunucusundan alınamadı.');
  await injectPromptToTab(tabId, prompt, role);
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'RECONNECT') {
    currentPortIndex = 0;
    if (socket) {
      try { socket.close(); } catch {}
      socket = null;
    }
    isAuthenticated = false;
    connectWebSocket();
    return Promise.resolve({ ok: true });
  }

  // AI'ın normal sohbet cevabını VS Code sohbet paneline aktarır (Kuyruk Korumalı)
  if (message.type === 'AI_RESPONSE_TEXT') {
    sendOrQueueWsMessage({
      jsonrpc: '2.0',
      method: 'bridge/ai_response',
      params: {
        text: message.text,
        source: message.source || 'Web AI'
      }
    });
    return Promise.resolve({ ok: true });
  }

  if (message.type === 'START_PIPELINE') {
    return (async () => {
      try {
        const { mode = '1', architectTabId, coderTabId } = await browser.storage.local.get([
          'mode', 'architectTabId', 'coderTabId'
        ]);

        if (mode === '1') {
          const targetId = await resolveTargetTabId('1', 'architectTabId');
          await dispatchRoleToTab(targetId, 'solo', '1');
        } else {
          if (!architectTabId || !coderTabId) throw new Error('Lütfen Mimar ve Kodlayıcı sekmelerini seçin.');
          if (architectTabId === coderTabId) throw new Error('Mimar ve Kodlayıcı farklı sekmeler olmalıdır.');
          await dispatchRoleToTab(architectTabId, 'architect', mode);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

  if (message.type === 'PIPELINE_HANDOFF') {
    return (async () => {
      try {
        const { mode = '1', architectTabId, coderTabId } = await browser.storage.local.get([
          'mode', 'architectTabId', 'coderTabId'
        ]);
        if (mode === '1') return { ok: true };

        if (message.targetRole === 'coder' && coderTabId) {
          await dispatchRoleToTab(coderTabId, 'coder', mode);
        } else if (message.targetRole === 'reviewer' && mode === '3' && architectTabId) {
          await dispatchRoleToTab(architectTabId, 'reviewer', mode);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

  if (message.type === 'AUTO_FAILOVER') {
    return (async () => {
      try {
        const failedTabId = sender?.tab?.id;
        const { mode = '1', architectTabId, coderTabId } = await browser.storage.local.get([
          'mode', 'architectTabId', 'coderTabId'
        ]);

        let currentRole = tabRoles.get(failedTabId);
        if (!currentRole) {
          if (mode === '1') currentRole = 'solo';
          else if (String(failedTabId) === String(coderTabId)) currentRole = 'coder';
          else currentRole = 'architect';
        }

        const nextTab = await findNextAvailableAiTab(failedTabId);

        if (currentRole === 'architect' || currentRole === 'reviewer') {
          await browser.storage.local.set({ architectTabId: String(nextTab.id) });
        } else if (currentRole === 'coder') {
          await browser.storage.local.set({ coderTabId: String(nextTab.id) });
        }

        sendOrQueueWsMessage({
          jsonrpc: '2.0',
          method: 'bridge/failover_notice',
          params: { reason: message.reason, nextTabTitle: nextTab.title, role: currentRole }
        });

        await dispatchRoleToTab(nextTab.id, currentRole, mode);
        return { ok: true, nextTabId: nextTab.id };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

  if (message.type === 'EXECUTE_MCP_CALL') {
    return sendRpcRequest('tools/call', {
      name: message.payload.tool,
      arguments: message.payload.arguments
    }).catch((err) => ({
      result: { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true }
    }));
  }
});

// Otomatik başlat ve 5 saniyede bir bağlantıyı denetle
connectWebSocket();
setInterval(() => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }
}, 5000);
