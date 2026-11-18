// @ts-check
'use strict';
const vscode = require('vscode');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const ui = require('./ui');
const { copyTokenToClipboard } = require('./auth');
const { listWorkspaceFiles } = require('./workspace');
const { buildSystemSetupPrompt, buildCleanUserMessage } = require('./prompts');
const { acceptChange, rejectChange } = require('./tools');
const { applyCodeToFile, saveCodeAsFile, smartMergeCode } = require('./codeActions');

/**
 * Kenar çubuğundaki sohbet paneli. Mesaj türü → işleyici eşlemesi ile çalışır.
 */
class WebMcpChatProvider {
  /**
   * @param {{ extensionPath: string, bridge: import('./bridgeServer').BridgeServer }} deps
   */
  constructor(deps) {
    this.deps = deps;
  }

  pushStatus() {
    const status = this.deps.bridge.getStatus();
    ui.post({ type: 'CONNECTION_STATUS', ...status });
    if (status.port) ui.post({ type: 'ACTIVE_PORT', port: status.port });
  }

  /** @param {import('vscode').WebviewView} webviewView */
  resolveWebviewView(webviewView) {
    ui.setView(webviewView);
    const mediaRoot = path.join(this.deps.extensionPath, 'media');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(mediaRoot)] };
    webviewView.webview.html = this.getHtmlContent(webviewView.webview, mediaRoot);
    webviewView.onDidDispose?.(() => ui.setView(null));

    const send = (method, params) => this.deps.bridge.request(method, params);

    /** @type {Record<string, (data: any) => Promise<void> | void>} */
    const handlers = {
      REQUEST_CONNECTION_STATUS: () => this.pushStatus(),
      COPY_TOKEN: () => copyTokenToClipboard(),
      RESTART_SERVER: () => {
        ui.log('🔄 WebSocket sunucusu yeniden başlatılıyor...');
        this.deps.bridge.restart();
      },
      REQUEST_FILES: async () => {
        let files = [];
        try { files = await listWorkspaceFiles(); } catch {}
        ui.post({ type: 'FILES_LIST', files });
      },
      INIT_AGENT_RULES: async (data) => {
        const role = data.mode === '1' ? 'solo' : 'architect';
        await send('bridge/execute_prompt', { prompt: await buildSystemSetupPrompt({ role, mode: data.mode }), mode: data.mode });
        ui.log('🧠 MCP araç kuralları AI sekmesine yüklendi.');
      },
      SEND_TASK: async (data) => {
        const prompt = await buildCleanUserMessage({
          userPrompt: String(data.prompt || ''),
          includeActiveFile: !!data.includeActiveFile,
          mentionedFiles: Array.isArray(data.mentionedFiles) ? data.mentionedFiles : []
        });
        await send('bridge/execute_prompt', { prompt, mode: data.mode });
      },
      APPLY_CODE_TO_FILE: (data) => applyCodeToFile(data.code, data.targetPath),
      APPLY_CODE_TO_ACTIVE: (data) => applyCodeToFile(data.code, data.targetPath),
      SMART_MERGE_CODE: (data) => smartMergeCode(data.code, data.targetPath, send),
      AUTO_CREATE_FILE: (data) => saveCodeAsFile(data.code, data.targetPath),
      SAVE_CODE_AS_NEW_FILE: (data) => saveCodeAsFile(data.code, null),
      ACCEPT_DIFF: async (data) => {
        await acceptChange(data.path);
        ui.post({ type: 'DIFF_RESOLVED', path: data.path, status: 'accepted' });
      },
      REJECT_DIFF: async (data) => {
        await rejectChange(data.path);
        ui.post({ type: 'DIFF_RESOLVED', path: data.path, status: 'rejected' });
      },
      LOG: (data) => ui.trace.error(String(data.text || ''))
    };

    webviewView.webview.onDidReceiveMessage(async (data) => {
      const handler = data && handlers[data.type];
      if (!handler) return;
      try {
        await handler(data);
      } catch (err) {
        ui.log(`⚠️ ${err.message}`, 'error');
      }
    });

    this.pushStatus();
    setTimeout(() => this.pushStatus(), 300);
  }

  /** @param {import('vscode').Webview} webview @param {string} mediaRoot */
  getHtmlContent(webview, mediaRoot) {
    const htmlPath = path.join(mediaRoot, 'webview.html');
    if (!fsSync.existsSync(htmlPath)) {
      return '<!DOCTYPE html><html><body><h3>Webview yüklenemedi: media/webview.html bulunamadı</h3></body></html>';
    }
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    return fsSync.readFileSync(htmlPath, 'utf8')
      .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
      .replace(/<script>/g, `<script nonce="${nonce}">`);
  }
}

module.exports = { WebMcpChatProvider };
