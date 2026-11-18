#!/usr/bin/env node
// Tarayıcı eklentilerini tek kaynaktan (src/browser) Chrome ve Firefox için üretir.
//   node scripts/build-browser.js          → extension-chrome/ ve extension-firefox/ yazar
//   node scripts/build-browser.js --check  → çıktılar güncel değilse hata verir (CI)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'browser');
const { CANDIDATE_PORTS } = require(path.join(ROOT, 'vscode-web-mcp', 'lib', 'constants.js'));
const { version } = require(path.join(ROOT, 'vscode-web-mcp', 'package.json'));

const AI_SITES = [
  'https://chatgpt.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'https://*.google.com/*',
  'https://google.com/*',
  'https://*.google.com.tr/*',
  'https://google.com.tr/*',
  'https://aistudio.google.com/*',
  'https://chat.deepseek.com/*',
  'https://kimi.moonshot.cn/*',
  'https://kimi.com/*',
  'https://www.kimi.com/*',
  'https://chatglm.cn/*',
  'https://z.ai/*',
  'https://chat.qwen.ai/*',
  'https://www.perplexity.ai/*',
  'https://grok.com/*',
  'https://chat.mistral.ai/*',
  'https://poe.com/*',
  'https://huggingface.co/*'
];

const TARGETS = {
  chrome: {
    outDir: path.join(ROOT, 'extension-chrome'),
    clientName: 'Chrome-MV3',
    title: '🔌 Web-to-MCP Bridge (Chrome)',
    accent: '#a6e3a1',
    manifest: {
      name: 'Web-to-MCP Multi-Agent Bridge (Chrome)',
      description: 'Chrome üzerinde Web AI arayüzlerini çoklu ajan mimarisi ve Auto-Failover ile VS Code MCP sunucusuna bağlar.',
      background: { service_worker: 'background.js' }
    }
  },
  firefox: {
    outDir: path.join(ROOT, 'extension-firefox'),
    clientName: 'Firefox-Gecko-MV3',
    title: '🦊 Web-to-MCP Bridge (Firefox)',
    accent: '#fab387',
    manifest: {
      name: 'Web-to-MCP Multi-Agent Bridge (Firefox)',
      description: 'Firefox üzerinde Web AI arayüzlerini çoklu ajan mimarisi ve Auto-Failover ile VS Code MCP sunucusuna bağlar.',
      browser_specific_settings: {
        gecko: {
          id: 'web-mcp-bridge-ff@local.dev',
          strict_min_version: '115.0',
          // Veriler yalnızca kullanıcının kendi bilgisayarındaki VS Code'a (127.0.0.1) iletilir; geliştiriciye veri gitmez.
          data_collection_permissions: { required: ['none'] }
        }
      },
      background: { scripts: ['background.js'] }
    }
  }
};

const JS_HEADER = '// OTOMATİK ÜRETİLDİ — düzenlemeyin. Kaynak: src/browser/ · Üretmek için: npm run build\n';
const HTML_HEADER = '<!-- OTOMATİK ÜRETİLDİ — düzenlemeyin. Kaynak: src/browser/ · Üretmek için: npm run build -->\n';

function buildManifest(target) {
  const t = TARGETS[target];
  const manifest = {
    manifest_version: 3,
    name: t.manifest.name,
    version,
    description: t.manifest.description,
    permissions: ['storage', 'tabs', 'alarms'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*', ...AI_SITES],
    content_security_policy: {
      extension_pages: "script-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*;"
    },
    ...(t.manifest.browser_specific_settings ? { browser_specific_settings: t.manifest.browser_specific_settings } : {}),
    background: t.manifest.background,
    action: { default_popup: 'popup.html' },
    content_scripts: [{ matches: AI_SITES, js: ['content.js'], run_at: 'document_idle' }]
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** @returns {Record<string, string>} dosya adı → içerik */
function renderTarget(target) {
  const t = TARGETS[target];
  const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  const background = read('background.js')
    .replace(/__TARGET__/g, target)
    .replace(/__CLIENT_NAME__/g, t.clientName)
    .replace(/__CANDIDATE_PORTS__/g, JSON.stringify(CANDIDATE_PORTS));
  const popupHtml = read('popup.html')
    .replace(/\{\{TITLE\}\}/g, t.title)
    .replace(/\{\{ACCENT\}\}/g, t.accent);
  return {
    'manifest.json': buildManifest(target),
    'background.js': JS_HEADER + background,
    'content.js': JS_HEADER + read('content.js'),
    'popup.js': JS_HEADER + read('popup.js'),
    'popup.html': popupHtml.replace('<!DOCTYPE html>\n', '<!DOCTYPE html>\n' + HTML_HEADER)
  };
}

function build({ check = false } = {}) {
  const stale = [];
  for (const target of Object.keys(TARGETS)) {
    const { outDir } = TARGETS[target];
    const files = renderTarget(target);
    if (!check) fs.mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const out = path.join(outDir, name);
      const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
      if (current === content) continue;
      if (check) stale.push(path.relative(ROOT, out));
      else fs.writeFileSync(out, content);
    }
  }
  return stale;
}

module.exports = { build, renderTarget, TARGETS };

if (require.main === module) {
  const check = process.argv.includes('--check');
  const stale = build({ check });
  if (check && stale.length) {
    console.error('Tarayıcı eklentisi çıktıları güncel değil. "npm run build" çalıştırın:\n  ' + stale.join('\n  '));
    process.exit(1);
  }
  console.log(check ? '✔ Tarayıcı eklentisi çıktıları güncel.' : `✔ Tarayıcı eklentileri üretildi (v${version}).`);
}
