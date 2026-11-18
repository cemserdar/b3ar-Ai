// @ts-check
'use strict';
const vscode = require('vscode');
const ui = require('./lib/ui');
const { loadOrCreateToken, copyTokenToClipboard, handlePairRequest } = require('./lib/auth');
const { getWorkspaceName } = require('./lib/workspace');
const { buildSystemSetupPrompt } = require('./lib/prompts');
const { executeTool, originalContentProvider, originalChangeEmitter } = require('./lib/tools');
const { BridgeServer } = require('./lib/bridgeServer');
const { WebMcpChatProvider } = require('./lib/webviewProvider');
const { BrowserHost } = require('./lib/browserHost');
const { StatusBar } = require('./lib/statusBar');
const setupWizard = require('./lib/setupWizard');
const { ORIGINAL_SCHEME } = require('./lib/constants');

/** @type {BridgeServer | null} */
let bridge = null;
/** @type {BrowserHost | null} */
let browserHost = null;

/** Tarayıcı eklentisine kimlik doğrulama sırasında iletilen istek kotası ayarları. */
function readLimits() {
  const cfg = vscode.workspace.getConfiguration('webMcp.limits');
  return {
    maxPromptsPerHour: cfg.get('maxPromptsPerHour', 60),
    maxPromptsPerDay: cfg.get('maxPromptsPerDay', 400),
    minSecondsBetweenPrompts: cfg.get('minSecondsBetweenPrompts', 3)
  };
}

/** @param {import('vscode').ExtensionContext} context */
async function activate(context) {
  context.subscriptions.push(ui.init());
  await loadOrCreateToken(context);

  const statusBar = new StatusBar();

  browserHost = new BrowserHost({
    storagePath: context.globalStorageUri.fsPath,
    extensionPath: context.extensionPath,
    onStateChange: (state, detail) => statusBar.setHost(state, detail)
  });
  const host = browserHost;

  bridge = new BridgeServer({
    getWorkspaceName,
    getLimits: readLimits,
    onPairRequest: handlePairRequest,
    onStatusChange: (status) => {
      statusBar.setBridge(status);
      ui.post({ type: 'CONNECTION_STATUS', ...status });
    },
    requestHandlers: {
      'tools/call': (params) => executeTool(params?.name, params?.arguments || {}),
      'bridge/get_role_prompt': async (params) => {
        const role = String(params?.role || 'solo');
        ui.log(`🔁 Ajan rolü yükleniyor -> ${role.toUpperCase()}`);
        return { prompt: await buildSystemSetupPrompt({ role, mode: String(params?.mode || '1') }) };
      }
    },
    notificationHandlers: {
      'bridge/ai_response': (params) => {
        if (params.text) ui.post({ type: 'AI_REPLY', text: String(params.text), source: String(params.source || 'AI') });
      },
      'bridge/failover_notice': (params) => {
        ui.log(`🔄 Auto-Failover: "${params.reason}" nedeniyle [${params.nextTabTitle}] sekmesine geçildi.`, 'warn');
      },
      'bridge/attention_required': (params) => { host.onAttentionRequired(params); },
      'bridge/quota_status': (params) => statusBar.setQuota(params),
      'bridge/log': (params) => ui.log(String(params.text || ''), params.level === 'warn' ? 'warn' : 'info')
    }
  });
  const server = bridge;
  server.start();

  const provider = new WebMcpChatProvider({ extensionPath: context.extensionPath, bridge: server });
  const wizardDeps = {
    extensionPath: context.extensionPath,
    storagePath: context.globalStorageUri.fsPath,
    browserHost: host,
    version: String(context.extension?.packageJSON?.version || '0.0.0'),
    globalState: context.globalState
  };

  context.subscriptions.push(
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originalContentProvider),
    originalChangeEmitter,
    vscode.window.registerWebviewViewProvider('webMcpChatView', provider),
    vscode.commands.registerCommand('webMcp.copyToken', copyTokenToClipboard),
    vscode.commands.registerCommand('webMcp.regenerateToken', async () => {
      await loadOrCreateToken(context, true);
      server.disconnectAll(4002, 'Token yenilendi');
      await copyTokenToClipboard();
    }),
    vscode.commands.registerCommand('webMcp.focusChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.web-mcp-sidebar');
    }),
    vscode.commands.registerCommand('webMcp.cleanPorts', () => {
      server.restart();
      vscode.window.showInformationMessage('🧹 WebSocket sunucusu yeniden başlatıldı.');
    }),
    vscode.commands.registerCommand('webMcp.showLogs', () => ui.init().show(true)),
    vscode.commands.registerCommand('webMcp.setup', () => setupWizard.runSetupWizard(wizardDeps)),
    vscode.commands.registerCommand('webMcp.browser.startHidden', () => host.start('hidden')),
    vscode.commands.registerCommand('webMcp.browser.showVisible', () => host.start('visible')),
    vscode.commands.registerCommand('webMcp.browser.stop', () => host.stop()),
    vscode.commands.registerCommand('webMcp.showMenu', async () => {
      const items = [
        { label: '$(rocket) Kurulum sihirbazı (tarayıcı eklentileri)', command: 'webMcp.setup' },
        { label: '$(eye-closed) Arka plan tarayıcısını gizli başlat', command: 'webMcp.browser.startHidden' },
        { label: '$(eye) Arka plan tarayıcısını görünür aç (giriş / doğrulama)', command: 'webMcp.browser.showVisible' },
        { label: '$(debug-stop) Arka plan tarayıcısını durdur', command: 'webMcp.browser.stop' },
        { label: '$(key) Bağlantı token\'ını kopyala', command: 'webMcp.copyToken' },
        { label: '$(refresh) WebSocket sunucusunu yeniden başlat', command: 'webMcp.cleanPorts' },
        { label: '$(output) Logları göster', command: 'webMcp.showLogs' },
        { label: '$(gear) Ayarlar', command: 'workbench.action.openSettings', args: ['webMcp'] }
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Web-MCP' });
      if (pick) vscode.commands.executeCommand(pick.command, ...(pick.args || []));
    })
  );

  if (vscode.workspace.getConfiguration('webMcp.browser').get('autoStartHidden', false)) {
    host.start('hidden');
  }

  // Aktivasyonu bekletmeden: tarayıcı eklentilerini senkronla, ilk kurulumda sihirbazı öner.
  setupWizard.onActivate(wizardDeps).catch(err => ui.trace.error(`Kurulum kontrolü hatası: ${err.message}`));
}

async function deactivate() {
  bridge?.stop();
  await browserHost?.stop();
  ui.dispose();
}

module.exports = { activate, deactivate };
