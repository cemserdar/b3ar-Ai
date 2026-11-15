const extApi = typeof browser !== 'undefined' ? browser : chrome;

const processedCallIds = new Set();
const processedSignals = new Set();
const processedFailovers = new Set();
const sentReplies = new Set();
let debounceTimer = null;

const LIMIT_ERROR_PATTERNS = [
  /you'?ve reached (your|the) (usage |message |chat )?limit/i,
  /usage limit reached/i,
  /message limit reached/i,
  /quota exceeded/i,
  /rate limit/i,
  /too many requests/i,
  /please try again later/i,
  /something went wrong/i,
  /network error/i,
  /an error occurred/i,
  /server is busy/i,
  /limitinize ulaştınız/i,
  /mesaj sınırına ulaştınız/i,
  /kullanım limiti/i,
  /çok fazla istek/i,
  /bir hata oluştu/i,
  /sunucu yoğun/i
];

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

  if (responseText && responseText.length < 600 && !responseText.includes('<mcp_call')) {
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
        return text.trim().length > 0 && !el.querySelector('textarea, [contenteditable="true"]');
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

function parseMcpCalls(text) {
  const calls = [];
  const callRegex = /<mcp_call\s+id="([^"]+)"\s+tool="([^"]+)">([\s\S]*?)<\/mcp_call>/g;
  let match;

  while ((match = callRegex.exec(text)) !== null) {
    const [, id, tool, innerXml] = match;
    if (processedCallIds.has(id)) continue;

    const args = {};
    const paramRegex = /<param\s+name="([^"]+)">(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/param>/g;
    let pMatch;

    while ((pMatch = paramRegex.exec(innerXml)) !== null) {
      const paramName = pMatch[1];
      const paramValue = pMatch[2] !== undefined ? pMatch[2] : pMatch[3];
      args[paramName] = paramValue;
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

async function injectAndSendResult(adapter, resultText) {
  const { autoSend = true } = await extApi.storage.local.get(['autoSend']);
  const inputEl = adapter.getInput() || UNIVERSAL_FALLBACK.getInput();

  if (!inputEl) return;

  setNativeValue(inputEl, resultText);
  if (!autoSend) return;

  const humanDelay = 1200 + Math.floor(Math.random() * 1200);

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
  }, humanDelay);
}

async function scanPageForCalls() {
  const adapter = getActiveAdapter();
  if (!adapter) return;
  if (adapter.isGenerating()) return;

  let responseText = adapter.getLastResponseText();
  if (!responseText && adapter !== UNIVERSAL_FALLBACK) {
    responseText = UNIVERSAL_FALLBACK.getLastResponseText();
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
  const replyHash = `${location.hostname}_${cleanReply.slice(0, 50)}_${cleanReply.length}`;
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
      processedCallIds.add(call.id);
      const response = await new Promise((resolve) => {
        extApi.runtime.sendMessage({ type: 'EXECUTE_MCP_CALL', payload: call }, resolve);
      });
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
    injectAndSendResult(adapter, message.prompt).then(() => sendResponse({ ok: true }));
    return true;
  }
});
