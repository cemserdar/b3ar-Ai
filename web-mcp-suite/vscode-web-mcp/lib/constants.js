// @ts-check
'use strict';

/**
 * Protokol sabitleri. CANDIDATE_PORTS tarayıcı eklentisindeki listeyle birebir aynı olmalıdır
 * (test/protocol.test.js bunu doğrular).
 */
module.exports = Object.freeze({
  CANDIDATE_PORTS: [8766, 8767, 8768, 8769, 8770, 8765],
  HOST: '127.0.0.1',

  TOKEN_SECRET_KEY: 'webMcp.authToken',
  AUTH_TIMEOUT_MS: 10000,
  ALLOWED_ORIGIN_REGEX: /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i,

  BROWSER_RPC_TIMEOUT_MS: 30000,
  COMMAND_TIMEOUT_MS: 120000,
  MAX_TOOL_OUTPUT_CHARS: 20000,
  MAX_READ_CHARS: 400000,

  BLOCKED_PATH_SEGMENTS: new Set(['.git']),
  IGNORED_DIR_NAMES: new Set(['node_modules', '.git', 'bin', 'obj', '.next', 'dist']),
  WORKSPACE_EXCLUDE_GLOB: '{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**,**/.next/**,**/dist/**,**/.mcp/**}',

  // Diff'in sol tarafı (orijinal içerik) diske yazılmadan bu şemadan sanal belge olarak sunulur.
  ORIGINAL_SCHEME: 'webmcp-original'
});
