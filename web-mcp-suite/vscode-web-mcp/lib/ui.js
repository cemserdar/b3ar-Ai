// @ts-check
'use strict';
const vscode = require('vscode');

/**
 * Webview'e mesaj gönderimi ve kalıcı log (Output → "Web-MCP") için tek nokta.
 * Diğer modüller webview örneğini bilmez; yalnızca bu modülü kullanır.
 */

/** @type {import('vscode').WebviewView | null} */
let view = null;
/** @type {import('vscode').LogOutputChannel | null} */
let output = null;

function init() {
  if (!output) output = vscode.window.createOutputChannel('Web-MCP', { log: true });
  return output;
}

/** @param {import('vscode').WebviewView | null} webviewView */
function setView(webviewView) {
  view = webviewView;
}

/** @param {Record<string, unknown>} msg */
function post(msg) {
  if (view) view.webview.postMessage(msg);
}

/**
 * Kullanıcıya görünen log: hem sohbet paneline hem Output kanalına yazılır.
 * @param {string} text
 * @param {'info' | 'warn' | 'error'} [level]
 */
function log(text, level = 'info') {
  post({ type: 'LOG', text });
  output?.[level](text);
}

/** Yalnızca Output kanalına (teşhis amaçlı) yazar. */
const trace = {
  /** @param {string} t */ info: (t) => output?.info(t),
  /** @param {string} t */ warn: (t) => output?.warn(t),
  /** @param {string} t */ error: (t) => output?.error(t)
};

function dispose() {
  output?.dispose();
  output = null;
  view = null;
}

module.exports = { init, setView, post, log, trace, dispose };
