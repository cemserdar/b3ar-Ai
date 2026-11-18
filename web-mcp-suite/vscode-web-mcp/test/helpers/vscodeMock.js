'use strict';
// Testler için minimal "vscode" modülü taklidi. installVscodeMock() çağrıldıktan sonra require('vscode') bunu döndürür.
const Module = require('module');
const path = require('path');

const state = {
  workspaceRoot: null,
  workspaceName: 'test-ws',
  warningAnswer: undefined, // showWarningMessage dönüşü (ör. 'Çalıştır')
  infoAnswer: undefined, // showInformationMessage dönüşü (ör. 'İzin Ver')
  config: {},
  clipboard: '',
  executed: [],
  messages: []
};

class EventEmitter {
  constructor() { this.event = () => ({ dispose() {} }); }
  fire() {}
  dispose() {}
}

const mock = {
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', path: p }),
    from: (o) => ({ ...o })
  },
  workspace: {
    get name() { return state.workspaceName; },
    get workspaceFolders() { return state.workspaceRoot ? [{ uri: { fsPath: state.workspaceRoot } }] : []; },
    findFiles: async () => [],
    asRelativePath: (p) => (typeof p === 'string' ? p : p.fsPath),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
    getConfiguration: (section) => ({
      get: (key, def) => {
        const full = `${section}.${key}`;
        return Object.prototype.hasOwnProperty.call(state.config, full) ? state.config[full] : def;
      }
    })
  },
  window: {
    showWarningMessage: async (...args) => { state.messages.push(['warn', args[0]]); return state.warningAnswer; },
    showInformationMessage: async (...args) => { state.messages.push(['info', args[0]]); return state.infoAnswer; },
    showErrorMessage: async (...args) => { state.messages.push(['error', args[0]]); },
    showTextDocument: async () => {},
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    createOutputChannel: () => ({ info() {}, warn() {}, error() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    activeTextEditor: null,
    tabGroups: { all: [] }
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (...args) => { state.executed.push(args); }
  },
  env: {
    clipboard: { writeText: async (t) => { state.clipboard = t; } },
    openExternal: async () => true
  }
};

let installed = false;
function installVscodeMock() {
  if (installed) return { mock, state };
  installed = true;
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return path.join(__dirname, 'vscodeMock.js#vscode');
    return original.call(this, request, ...rest);
  };
  require.cache[path.join(__dirname, 'vscodeMock.js#vscode')] = {
    id: 'vscode', filename: 'vscode', loaded: true, exports: mock
  };
  return { mock, state };
}

module.exports = { installVscodeMock, state, mock };
