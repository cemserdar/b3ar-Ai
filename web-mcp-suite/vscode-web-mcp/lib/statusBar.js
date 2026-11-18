// @ts-check
'use strict';
const vscode = require('vscode');

const HOST_LABELS = {
  stopped: '',
  starting: ' · $(sync~spin) tarayıcı',
  hidden: ' · $(eye-closed) gizli',
  visible: ' · $(eye) görünür',
  error: ' · $(warning) tarayıcı'
};

/**
 * Durum çubuğu: bağlantı + arka plan tarayıcısı + istek kotası. Tıklanınca hızlı menü açılır.
 */
class StatusBar {
  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = 'webMcp.showMenu';
    /** @type {{ connected: boolean, port: number | null, client?: string }} */
    this.bridge = { connected: false, port: null };
    /** @type {keyof typeof HOST_LABELS} */
    this.host = 'stopped';
    this.hostDetail = '';
    /** @type {{ usedHour: number, limitHour: number, usedDay: number, limitDay: number } | null} */
    this.quota = null;
    this.render();
    this.item.show();
  }

  /** @param {{ connected: boolean, port: number | null, client?: string }} status */
  setBridge(status) { this.bridge = status; this.render(); }

  /** @param {keyof typeof HOST_LABELS} state @param {string} [detail] */
  setHost(state, detail = '') { this.host = state; this.hostDetail = detail; this.render(); }

  /** @param {{ usedHour: number, limitHour: number, usedDay: number, limitDay: number }} quota */
  setQuota(quota) { this.quota = quota; this.render(); }

  render() {
    const icon = this.bridge.connected ? '$(plug)' : '$(debug-disconnect)';
    const quota = this.quota ? ` · ${this.quota.usedHour}/${this.quota.limitHour} sa` : '';
    this.item.text = `${icon} Web-MCP${HOST_LABELS[this.host] || ''}${quota}`;
    const lines = [
      this.bridge.connected ? `Tarayıcı bağlı (${this.bridge.client || 'eklenti'}, port ${this.bridge.port})` : `Tarayıcı bağlı değil (port ${this.bridge.port ?? '-'})`,
      `Arka plan tarayıcısı: ${this.host}${this.hostDetail ? ' — ' + this.hostDetail : ''}`
    ];
    if (this.quota) lines.push(`İstek kotası: saatlik ${this.quota.usedHour}/${this.quota.limitHour}, günlük ${this.quota.usedDay}/${this.quota.limitDay}`);
    this.item.tooltip = lines.join('\n');
    this.item.backgroundColor = this.host === 'error'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  dispose() { this.item.dispose(); }
}

module.exports = { StatusBar };
