const extApi = typeof browser !== 'undefined' ? browser : chrome;

// Uzun oturumlarda belleğin sınırsız büyümemesi için en eski kayıtları atan Set.
class BoundedSet extends Set {
  constructor(max = 500) { super(); this.max = max; }
  add(value) {
    super.add(value);
    if (this.size > this.max) this.delete(this.values().next().value);
    return this;
  }
}

// Çalıştırılmış çağrılar id+araç+parametre imzasıyla tutulur: AI sonraki yanıtta yine "req_01"
// kullansa bile farklı parametreli çağrı atlanmaz; aynı çağrı ise iki kez çalışmaz.
const processedCallSignatures = new BoundedSet(1000);
const processedSignals = new BoundedSet();
const processedFailovers = new BoundedSet();
const sentReplies = new BoundedSet();
// Bu sekmeye bizim yazdığımız metinlerdeki (kurulum kılavuzu örnekleri, araç sonuçları,
// okunan dosya içerikleri) <mcp_call> blokları asla çalıştırılmaz.
const injectedCallSignatures = new BoundedSet(1000);
let debounceTimer = null;
let isScanning = false;
// Yanıtın bittiğinden emin olmak için metin iki ardışık taramada aynı kalmalı.
let lastObservedText = null;

const USER_MESSAGE_SELECTOR = [
  '[data-message-author-role="user"]',
  '[data-testid*="user" i]',
  '[class*="user-message" i]',
  '[class*="user_message" i]',
  '[class*="human" i]',
  '.user-query'
].join(', ');

// Yalnızca kota/limit anlamı taşıyan özgül ifadeler. "something went wrong", "rate limit" gibi
// genel ifadeler AI'ın normal yanıtlarında da geçtiği için yanlış failover tetikliyordu.
const LIMIT_ERROR_PATTERNS = [
  /you'?ve (reached|hit) (your|the) (daily |usage |message |chat )?limit/i,
  /usage limit (reached|exceeded)/i,
  /message limit reached/i,
  /quota (exceeded|reached)/i,
  /rate limit (reached|exceeded)/i,
  /too many requests/i,
  /server is busy/i,
  /limitinize ulaştınız/i,
  /mesaj sınırına ulaştınız/i,
  /kullanım limitine ulaştınız/i,
  /çok fazla istek/i,
  /sunucu (şu anda )?(çok )?yoğun/i
];
const LIMIT_RESPONSE_MAX_LEN = 300;

function isElementVisible(el) {
  if (!el) return false;
  try {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch {
    return false;
  }
}

function extractFormattedMarkdown(rootElement) {
  if (!rootElement) return '';

  // Eğer kod bloğu (pre) yoksa doğrudan canlı ve görünür DOM'dan oku
  if (!rootElement.querySelector('pre')) {
    const raw = (rootElement.innerText || rootElement.textContent || '').trim();
    if (raw) return raw;
  }

  const clone = rootElement.cloneNode(true);
  clone.querySelectorAll('button, [role="button"], .sr-only, svg').forEach(el => el.remove());

  const preBlocks = clone.querySelectorAll('pre');
  preBlocks.forEach((pre) => {
    const codeEl = pre.querySelector('code') || pre;
    let lang = '';

    const classSources = `${pre.className || ''} ${codeEl.className || ''}`;
    const langMatch = classSources.match(/(?:language-|lang-|hljs-)([a-zA-Z0-9_+#-]+)/i);
    if (langMatch && langMatch[1] && langMatch[1].toLowerCase() !== 'hljs') {
      lang = langMatch[1].toLowerCase();
    }

    if (!lang) {
      const headerEl = pre.querySelector('[class*="header" i], [class*="lang" i], [class*="title" i]');
      if (headerEl) {
        const candidate = (headerEl.textContent || '').trim().split(/\s+/)[0].toLowerCase();
        if (/^[a-z0-9_+#-]{1,15}$/.test(candidate) && candidate !== 'copy' && candidate !== 'kopyala') {
          lang = candidate;
        }
        headerEl.remove();
      }
    }

    const rawCode = (codeEl.textContent || '').replace(/^\n+|\n+$/g, '');
    const markdownBlock = `\n\`\`\`${lang}\n${rawCode}\n\`\`\`\n`;

    const replacement = document.createTextNode(markdownBlock);
    pre.parentNode.replaceChild(replacement, pre);
  });

  clone.querySelectorAll('code').forEach((inlineCode) => {
    const txt = inlineCode.textContent || '';
    if (!txt.includes('\n')) {
      inlineCode.replaceWith(document.createTextNode(`\`${txt}\``));
    }
  });

  const tempHost = document.createElement('div');
  tempHost.style.cssText = 'position: absolute; opacity: 0; pointer-events: none; width: 800px; top: 0; left: 0; z-index: -9999; white-space: pre-wrap;';
  tempHost.appendChild(clone);
  document.body.appendChild(tempHost);

  const formattedText = (tempHost.innerText || clone.textContent || '').trim();
  document.body.removeChild(tempHost);
  return formattedText;
}

function getLastElementText(selectors) {
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      for (let i = els.length - 1; i >= 0; i--) {
        const text = extractFormattedMarkdown(els[i]);
        if (text && text.trim().length > 0) {
          return text.trim();
        }
      }
    }
  }
  return '';
}

function detectLimitOrError(responseText) {
  const hasUserMessages = document.querySelectorAll(
    '[data-message-author-role="user"], [data-testid="user-message"], .user-query, .ds-message'
  ).length > 0;
  if (!hasUserMessages) return null;

  if (responseText && responseText.length < LIMIT_RESPONSE_MAX_LEN && !responseText.includes('<mcp_call')) {
    for (const pattern of LIMIT_ERROR_PATTERNS) {
      if (pattern.test(responseText)) {
        return responseText.trim().substring(0, 120);
      }
    }
  }

  const alertEls = document.querySelectorAll('[role="alert"], [class*="error" i], [class*="limit" i], [class*="toast" i], [class*="warning" i]');
  for (const el of alertEls) {
    if (!isElementVisible(el)) continue;
    const text = (el.innerText || '').trim();
    if (text.length > 5 && text.length < 400) {
      for (const pattern of LIMIT_ERROR_PATTERNS) {
        if (pattern.test(text)) {
          return text.substring(0, 120);
        }
      }
    }
  }

  return null;
}

function findVisibleInput(selectors) {
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 15 && !el.disabled) return el;
    }
  }
  return null;
}

function findVisibleButton(selectors) {
  for (const sel of selectors) {
    const btns = document.querySelectorAll(sel);
    for (const btn of btns) {
      if (isElementVisible(btn) && !btn.disabled) return btn;
    }
  }
  return null;
}

const SITE_ADAPTERS = {
  chatgpt: {
    match: () => location.hostname.includes('chatgpt.com'),
    isGenerating: () => {
      const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Durdur" i]');
      return isElementVisible(stopBtn);
    },
    getLastResponseText: () => getLastElementText([
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]',
      'article [data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
      'div[data-message-author-role="assistant"]'
    ]),
    getInput: () => findVisibleInput(['#prompt-textarea', 'textarea[data-id="root"]', 'textarea']),
    getSendButton: () => findVisibleButton(['button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="Gönder" i]'])
  },
  claude: {
    match: () => location.hostname.includes('claude.ai'),
    isGenerating: () => {
      const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Durdur" i]');
      return isElementVisible(stopBtn);
    },
    getLastResponseText: () => getLastElementText(['.font-claude-message', '[data-test-render-count] .grid']),
    getInput: () => findVisibleInput(['div[contenteditable="true"].ProseMirror']),
    getSendButton: () => findVisibleButton(['button[aria-label*="Send" i], button[aria-label*="Gönder" i]'])
  },
  gemini: {
    match: () => location.hostname.includes('gemini.google.com'),
    isGenerating: () => {
      const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Durdur" i], .stop-icon');
      return isElementVisible(stopBtn);
    },
    getLastResponseText: () => getLastElementText([
      'message-content',
      '.model-response-text',
      '.response-container-content',
      'model-response',
      '[data-test-id="model-turn"]',
      '.model-turn'
    ]),
    getInput: () => findVisibleInput(['div[contenteditable="true"][role="textbox"]']),
    getSendButton: () => findVisibleButton(['button[aria-label*="Send" i], button[aria-label*="Gönder" i]'])
  },
  googleAiMode: {
    match: () => {
      if (!location.hostname.includes('google.com')) return false;
      const params = new URLSearchParams(location.search);
      return (
        params.get('udm') === '50' ||
        !!document.querySelector('[data-subtree="aimc"], [data-attrid="wa:/description"], textarea[placeholder*="Soru sorun"], textarea[placeholder*="Ask"]')
      );
    },
    isGenerating: () => {
      const stopBtns = document.querySelectorAll('button[aria-label*="Stop" i], button[aria-label*="Durdur" i]');
      for (const btn of stopBtns) {
        if (isElementVisible(btn)) return true;
      }
      return false;
    },
    getLastResponseText: () => {
      const selectors = [
        '[data-subtree="aimc"]',
        '[data-attrid="wa:/description"]',
        '.Y3BBE',
        '[data-md]',
        'div[jscontroller] .markdown'
      ];

      for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel)).filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.height > 20 && (el.innerText || '').trim().length > 0;
        });
        if (els.length > 0) {
          return extractFormattedMarkdown(els[els.length - 1]);
        }
      }

      const pres = document.querySelectorAll('pre');
      if (pres.length > 0) {
        const lastPre = pres[pres.length - 1];
        const container = lastPre.closest('[data-ved], [jscontroller], article, section') || lastPre.parentElement;
        if (container) return extractFormattedMarkdown(container);
      }

      return '';
    },
    getInput: () => findVisibleInput([
      'textarea[placeholder*="Soru sorun"]',
      'textarea[aria-label*="Ask"]',
      'textarea[placeholder*="Ask"]',
      'textarea[aria-label*="Sor"]',
      'textarea[name="q"]'
    ]),
    getSendButton: () => findVisibleButton([
      'button[aria-label*="Send" i]',
      'button[aria-label*="Gönder" i]',
      'button[type="submit"]'
    ])
  },
  aiStudio: {
    match: () => location.hostname.includes('aistudio.google.com'),
    isGenerating: () => {
      const stopBtn = document.querySelector('button[aria-label*="Stop" i], ms-run-button button.stoppable');
      return isElementVisible(stopBtn);
    },
    getLastResponseText: () => getLastElementText(['ms-chat-turn .model-prompt-container', 'ms-cmark-node']),
    getInput: () => findVisibleInput(['textarea[aria-label*="Type something" i], ms-autosize-textarea textarea', 'textarea']),
    getSendButton: () => findVisibleButton(['ms-run-button button', 'button[aria-label*="Run" i]'])
  },
  deepseek: {
    match: () => location.hostname.includes('deepseek.com'),
    isGenerating: () => {
      const stopBtn = document.querySelector('div[role="button"] svg rect, button[aria-label*="Stop" i], ._7436101');
      return isElementVisible(stopBtn);
    },
    getLastResponseText: () => getLastElementText(['.ds-markdown', '.ds-message']),
    getInput: () => findVisibleInput(['textarea#chat-input', 'textarea']),
    getSendButton: () => findVisibleButton(['div[role="button"][aria-disabled="false"]', 'button[type="submit"]'])
  },
  kimi: {
    match: () => location.hostname.includes('kimi.moonshot.cn') || location.hostname.includes('kimi.com'),
    isGenerating: () => {
      const stopBtn = document.querySelector('button[class*="stop" i], [data-testid*="stop" i]');
      return isElementVisible(stopBtn);
    },
    getLastResponseText: () => getLastElementText(['[class*="markdown" i]', '[class*="segment-content" i]', '.chat-content-item']),
    getInput: () => findVisibleInput(['div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', 'textarea']),
    getSendButton: () => findVisibleButton(['button[class*="send" i]', 'button[type="submit"]', 'button[aria-label*="Send" i]'])
  },
  glm: {
    match: () => location.hostname.includes('chatglm.cn') || location.hostname.includes('z.ai'),
    isGenerating: () => {
      const stopBtn = document.querySelector('[class*="stop" i], button[aria-label*="Stop" i]');
      return isElementVisible(stopBtn);
    },
    getLastResponseText: () => getLastElementText(['.markdown-body', '[class*="message-content" i]', '[class*="answer" i]']),
    getInput: () => findVisibleInput(['textarea', 'div[contenteditable="true"]']),
    getSendButton: () => findVisibleButton(['button[class*="send" i]', 'div[class*="send-btn" i]', 'button[type="submit"]'])
  },
  qwen: {
    match: () => location.hostname.includes('qwen.ai') || location.hostname.includes('tongyi.aliyun.com'),
    isGenerating: () => {
      const stopBtn = document.querySelector('button[class*="stop" i], [aria-label*="Stop" i]');
      return isElementVisible(stopBtn);
    },
    getLastResponseText: () => getLastElementText(['.markdown-body', '[class*="message-content" i]', '[class*="response-content" i]']),
    getInput: () => findVisibleInput(['textarea#chat-input', 'textarea', 'div[contenteditable="true"]']),
    getSendButton: () => findVisibleButton(['button[id*="send" i]', 'button[class*="send" i]', 'button[type="submit"]'])
  }
};

const UNIVERSAL_FALLBACK = {
  isGenerating: () => {
    const btns = document.querySelectorAll('button[aria-label*="Stop" i], button[aria-label*="Durdur" i], button[data-testid*="stop" i]');
    for (const btn of btns) {
      if (isElementVisible(btn)) return true;
    }
    return false;
  },
  getLastResponseText: () => {
    const candidates = Array.from(document.querySelectorAll('article, .markdown-body, .prose, [class*="markdown" i], [class*="message" i]'))
      .filter(el => {
        const text = el.innerText || '';
        return text.trim().length > 0 &&
          !el.querySelector('textarea, [contenteditable="true"]') &&
          // Kullanıcı mesajlarını (ve onları kapsayan konteynerleri) asla AI yanıtı sayma
          !el.closest(USER_MESSAGE_SELECTOR) &&
          !el.querySelector(USER_MESSAGE_SELECTOR);
      });
    return candidates.length ? extractFormattedMarkdown(candidates[candidates.length - 1]) : '';
  },
  getInput: () => findVisibleInput(['textarea', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]']),
  getSendButton: () => findVisibleButton([
    'button[data-testid*="send" i]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Gönder" i]',
    'button[type="submit"]'
  ])
};

function getActiveAdapter() {
  if (location.hostname.includes('google.com') && !location.hostname.includes('aistudio') && !location.hostname.includes('gemini')) {
    if (!SITE_ADAPTERS.googleAiMode.match()) return null;
  }
  return Object.values(SITE_ADAPTERS).find(adapter => adapter.match()) || UNIVERSAL_FALLBACK;
}

function callSignature(call) {
  const argPairs = Object.keys(call.arguments).sort().map(k => [k, String(call.arguments[k]).trim()]);
  return `${call.id}|${call.tool}|${JSON.stringify(argPairs)}`;
}

function rememberInjectedCalls(text) {
  for (const call of extractMcpCalls(text || '')) {
    injectedCallSignatures.add(callSignature(call));
  }
}

function parseMcpCalls(text) {
  return extractMcpCalls(text).filter(call =>
    !call.id.startsWith('ornek_') && // Kurulum kılavuzundaki örnek çağrılar
    !processedCallSignatures.has(callSignature(call)) &&
    !injectedCallSignatures.has(callSignature(call))
  );
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readXmlAttribute(attrText, name) {
  const m = attrText.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2]) : null;
}

function extractMcpCalls(text) {
  const calls = [];
  // Öznitelik sırası ve tırnak tipi serbest: <mcp_call tool="x" id="y"> da kabul edilir.
  const callRegex = /<mcp_call\b([^>]*)>([\s\S]*?)<\/mcp_call>/g;
  let match;

  while ((match = callRegex.exec(text)) !== null) {
    const [, attrText, innerXml] = match;
    const tool = readXmlAttribute(attrText, 'tool');
    if (!tool) continue;
    const id = readXmlAttribute(attrText, 'id') || `auto_${tool}`;

    const args = {};
    // CDATA öncesi/sonrası boşluklara tolerans: aksi halde "<![CDATA[" metni içeriğe karışırdı.
    const paramRegex = /<param\s+name\s*=\s*["']([^"']+)["']\s*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>\s*|([\s\S]*?))<\/param>/g;
    let pMatch;

    while ((pMatch = paramRegex.exec(innerXml)) !== null) {
      const paramName = pMatch[1];
      args[paramName] = pMatch[2] !== undefined ? pMatch[2] : decodeXmlEntities(pMatch[3].trim());
    }

    calls.push({ id, tool, arguments: args });
  }
  return calls;
}

function setNativeValue(element, value) {
  element.focus();
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    const prototype = Object.getPrototypeOf(element);
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (valueSetter) valueSetter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    extApi.runtime.sendMessage(message, (response) => {
      if (extApi.runtime.lastError) {
        resolve({ ok: false, error: extApi.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

// Metni giriş kutusuna yazar ve (izin verilirse) gönderir. Kota dolmuşsa metin kutuda bekletilir.
async function injectAndSendResult(adapter, resultText) {
  rememberInjectedCalls(resultText);
  const { autoSend = true } = await extApi.storage.local.get(['autoSend']);
  const inputEl = adapter.getInput() || UNIVERSAL_FALLBACK.getInput();

  if (!inputEl) return { ok: false, error: 'AI sayfasında mesaj giriş kutusu bulunamadı (giriş yapılmamış olabilir).' };

  setNativeValue(inputEl, resultText);
  if (!autoSend) return { ok: true, sent: false };

  const slot = await sendRuntimeMessage({ type: 'ACQUIRE_SEND_SLOT' });
  if (!slot?.ok) return { ok: true, sent: false, reason: slot?.reason || slot?.error };

  // Sitenin giriş kutusundaki değişikliği işleyip "Gönder" butonunu etkinleştirmesi için kısa bekleme.
  const sendDelay = 1000 + (slot.waitMs || 0);

  setTimeout(() => {
    const sendBtn = adapter.getSendButton() || UNIVERSAL_FALLBACK.getSendButton();
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      const isAiStudio = location.hostname.includes('aistudio.google.com');
      inputEl.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          ctrlKey: isAiStudio,
          metaKey: isAiStudio,
          bubbles: true
        })
      );
    }
  }, sendDelay);
  return { ok: true, sent: true };
}

// ---------------------------------------------------------------------------
// Doğrulama / giriş ekranı algılama (arka plan modunda tarayıcıyı görünür açtırmak için)
// ---------------------------------------------------------------------------
const CHALLENGE_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="recaptcha"]',
  '#challenge-form',
  '#cf-challenge-running',
  '[id^="cf-chl"]',
  '.cf-turnstile'
];
const CHALLENGE_TITLE_REGEX = /just a moment|attention required|verify you are human|bir dakika lütfen|insan olduğunuzu doğrulayın/i;
const LOGIN_TEXT_REGEX = /^(log in|login|sign in|sign up|giriş yap|oturum aç|kaydol)$/i;
let lastAttentionKey = '';
let lastAttentionAt = 0;

function detectAttentionReason(adapter) {
  if (CHALLENGE_TITLE_REGEX.test(document.title || '')) return 'Bot doğrulaması (CAPTCHA) gerekiyor';
  for (const sel of CHALLENGE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && isElementVisible(el)) return 'Bot doğrulaması (CAPTCHA) gerekiyor';
  }
  // Giriş kutusu yoksa ve sayfada belirgin bir "Giriş yap" butonu varsa oturum kapanmıştır.
  if (adapter && !adapter.getInput() && !UNIVERSAL_FALLBACK.getInput()) {
    const buttons = document.querySelectorAll('button, a[role="button"], a[href*="login"], a[href*="signin"]');
    for (const btn of buttons) {
      if (LOGIN_TEXT_REGEX.test((btn.textContent || '').trim()) && isElementVisible(btn)) return 'AI sitesinde oturum açmanız gerekiyor';
    }
  }
  return null;
}

function checkForAttention(adapter) {
  const reason = detectAttentionReason(adapter);
  if (!reason) return false;
  const key = `${location.hostname}|${reason}`;
  if (key !== lastAttentionKey || Date.now() - lastAttentionAt > 120000) {
    lastAttentionKey = key;
    lastAttentionAt = Date.now();
    sendRuntimeMessage({ type: 'ATTENTION_REQUIRED', reason: `${reason} (${location.hostname})` });
  }
  return true;
}

function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function executeMcpCall(call) {
  return new Promise((resolve) => {
    extApi.runtime.sendMessage({ type: 'EXECUTE_MCP_CALL', payload: call }, (response) => {
      const lastError = extApi.runtime.lastError;
      if (lastError || !response) {
        resolve({ result: { content: [{ type: 'text', text: `ERROR: Eklenti arka planına ulaşılamadı (${lastError?.message || 'yanıt yok'}).` }], isError: true } });
        return;
      }
      resolve(response);
    });
  });
}

// Taramalar hem MutationObserver hem de zamanlayıcı ile tetiklenir; kilit aynı yanıtın
// iki taramada eş zamanlı işlenmesini (çift araç çalıştırma / çift yapıştırma) engeller.
async function scanPageForCalls() {
  if (isScanning) return;
  isScanning = true;
  try {
    await scanPageForCallsUnlocked();
  } catch (err) {
    console.warn('[Web-MCP Content] Tarama hatası:', err);
  } finally {
    isScanning = false;
  }
}

async function scanPageForCallsUnlocked() {
  const adapter = getActiveAdapter();
  if (!adapter) return;
  if (checkForAttention(adapter)) return;
  if (adapter.isGenerating()) return;

  let responseText = adapter.getLastResponseText();
  if (!responseText && adapter !== UNIVERSAL_FALLBACK) {
    responseText = UNIVERSAL_FALLBACK.getLastResponseText();
  }

  // "Durdur" butonu kısa süreliğine kaybolabilir; metin değişmeye devam ediyorsa yanıt bitmemiştir.
  if (responseText !== lastObservedText) {
    lastObservedText = responseText;
    return;
  }

  const limitReason = detectLimitOrError(responseText);
  if (limitReason) {
    const failoverKey = `${location.hostname}_${limitReason}`;
    if (!processedFailovers.has(failoverKey)) {
      processedFailovers.add(failoverKey);
      extApi.runtime.sendMessage({ type: 'AUTO_FAILOVER', reason: limitReason });
      return;
    }
  }

  if (!responseText) return;

  const cleanReply = responseText.trim();
  const replyHash = `${location.hostname}_${cleanReply.length}_${hashText(cleanReply)}`;
  if (cleanReply.length > 0 && !sentReplies.has(replyHash)) {
    sentReplies.add(replyHash);
    console.log('[Web-MCP Content] AI yanıtı yakalandı ve gönderiliyor:', cleanReply.substring(0, 60));
    extApi.runtime.sendMessage({
      type: 'AI_RESPONSE_TEXT',
      text: cleanReply,
      source: location.hostname.replace('www.', '')
    }, () => {
      if (extApi.runtime.lastError) {
        console.warn('[Web-MCP Content] Mesaj gönderme uyarısı:', extApi.runtime.lastError.message);
      }
    });
  }

  const calls = parseMcpCalls(responseText);
  if (calls.length > 0) {
    const resultsOutput = [];
    for (const call of calls) {
      processedCallSignatures.add(callSignature(call));
      const response = await executeMcpCall(call);
      const textResult = response?.result?.content?.[0]?.text || 'Bilinmeyen sunucu yanıtı';
      const status = response?.result?.isError ? 'ERROR' : 'OK';
      resultsOutput.push(`[MCP_RESULT id="${call.id}" status="${status}"]\n${textResult}\n[/MCP_RESULT]`);
    }

    if (resultsOutput.length > 0) {
      await injectAndSendResult(adapter, resultsOutput.join('\n\n'));
      return;
    }
  }

  const messageCount = document.querySelectorAll('[data-message-author-role="assistant"], .font-claude-message, message-content, .ds-markdown, .markdown-body').length;
  const signalKey = `${location.hostname}_${messageCount}`;
  if (!processedSignals.has(signalKey)) {
    if (responseText.includes('<handoff_to_coder/>')) {
      processedSignals.add(signalKey);
      extApi.runtime.sendMessage({ type: 'PIPELINE_HANDOFF', targetRole: 'coder' });
    } else if (responseText.includes('<handoff_to_reviewer/>')) {
      processedSignals.add(signalKey);
      extApi.runtime.sendMessage({ type: 'PIPELINE_HANDOFF', targetRole: 'reviewer' });
    }
  }
}

const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(scanPageForCalls, 800);
});

observer.observe(document.body, { childList: true, subtree: true, characterData: true });

// MutationObserver'a ek olarak, DOM mutasyonu bittiğinde AI yanıtını kaçırmamak için periyodik kontrol
setInterval(scanPageForCalls, 1000);

extApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_HANDOFF' && message.prompt) {
    const adapter = getActiveAdapter() || UNIVERSAL_FALLBACK;
    injectAndSendResult(adapter, message.prompt).then(
      (result) => sendResponse(result || { ok: true }),
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true;
  }
});
