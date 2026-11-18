// @ts-check
'use strict';
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { tokensMatch } = require('./auth');
const ui = require('./ui');
const {
  CANDIDATE_PORTS,
  HOST,
  AUTH_TIMEOUT_MS,
  ALLOWED_ORIGIN_REGEX,
  BROWSER_RPC_TIMEOUT_MS
} = require('./constants');

const WS_OPEN = 1;

/**
 * @typedef {{ connected: boolean, port: number | null, client?: string }} BridgeStatus
 * @typedef {(params: any) => Promise<unknown> | unknown} RequestHandler
 * @typedef {(params: any) => void} NotificationHandler
 */

/**
 * VS Code ↔ tarayıcı eklentisi JSON-RPC köprüsü (127.0.0.1, yalnızca eklenti origin'leri, token zorunlu).
 */
class BridgeServer {
  /**
   * @param {{
   *   getWorkspaceName: () => string,
   *   getLimits?: () => object,
   *   onPairRequest?: (info: { client: string, origin: string }) => Promise<string | null>,
   *   requestHandlers: Record<string, RequestHandler>,
   *   notificationHandlers: Record<string, NotificationHandler>,
   *   onStatusChange?: (status: BridgeStatus) => void
   * }} options
   */
  constructor(options) {
    this.options = options;
    /** @type {import('ws').WebSocketServer | null} */
    this.wss = null;
    /** @type {number | null} */
    this.port = null;
    /** Kimliği doğrulanmış bağlantılar (en son bağlanan aktif istemcidir). @type {Map<import('ws').WebSocket, string>} */
    this.authedClients = new Map();
    /** @type {Map<string, { settle: (msg: any) => void, fail: (err: Error) => void }>} */
    this.pending = new Map();
  }

  /** @returns {import('ws').WebSocket | null} */
  get activeClient() {
    let last = null;
    for (const ws of this.authedClients.keys()) if (ws.readyState === WS_OPEN) last = ws;
    return last;
  }

  get isConnected() {
    return !!this.activeClient;
  }

  /** @returns {BridgeStatus} */
  getStatus() {
    const client = this.activeClient;
    return { connected: !!client, port: this.port, client: client ? this.authedClients.get(client) : undefined };
  }

  emitStatus() {
    this.options.onStatusChange?.(this.getStatus());
  }

  start(portIndex = 0) {
    if (this.wss || this.startingServer) return;
    if (portIndex >= CANDIDATE_PORTS.length) {
      ui.log(`❌ Tüm portlar (${CANDIDATE_PORTS.join(', ')}) meşgul! Kullanılmayan VS Code pencerelerini veya süreçleri kapatın.`, 'error');
      return;
    }
    const port = CANDIDATE_PORTS[portIndex];
    const server = new WebSocketServer({
      port,
      host: HOST,
      // Web sayfaları localhost'a WebSocket açabilir; yalnızca tarayıcı eklentilerini kabul et.
      verifyClient: (info) => {
        const ok = ALLOWED_ORIGIN_REGEX.test(info.origin || '');
        if (!ok) ui.trace.warn(`Yetkisiz kaynak reddedildi: ${info.origin || '(origin yok)'}`);
        return ok;
      }
    });
    // Dinleme başlamadan stop() çağrılırsa bu örnek de kapatılabilsin (port sızıntısı olmasın).
    this.startingServer = server;

    server.on('listening', () => {
      if (this.startingServer !== server) { try { server.close(); } catch {} return; }
      this.startingServer = null;
      this.wss = server;
      this.port = port;
      ui.log(`✅ WebSocket sunucusu (${HOST}:${port}) aktif. Tarayıcı bağlantısı bekleniyor...`);
      ui.post({ type: 'ACTIVE_PORT', port });
      this.emitStatus();
    });

    server.on('error', (err) => {
      if (/** @type {any} */ (err).code === 'EADDRINUSE') {
        ui.trace.warn(`Port ${port} meşgul, sıradaki port deneniyor...`);
        try { server.close(); } catch {}
        if (this.startingServer !== server) return; // bu arada durduruldu
        this.startingServer = null;
        this.start(portIndex + 1);
      } else {
        ui.log(`⚠️ Sunucu hatası (${port}): ${err.message}`, 'error');
      }
    });

    server.on('connection', (ws, req) => this.handleConnection(ws, String(req.headers.origin || '')));
  }

  stop(reason = 'WebSocket sunucusu kapatıldı.') {
    if (this.startingServer) {
      try { this.startingServer.close(); } catch {}
      this.startingServer = null;
    }
    if (!this.wss) return;
    for (const client of this.wss.clients) {
      try { client.terminate(); } catch {}
    }
    try { this.wss.close(); } catch {}
    this.wss = null;
    this.port = null;
    this.authedClients.clear();
    this.failPending(reason);
    this.emitStatus();
  }

  restart() {
    this.stop('WebSocket sunucusu yeniden başlatıldı.');
    this.start(0);
  }

  /** Token yenilendiğinde mevcut oturumları düşürür. */
  disconnectAll(code = 4002, reason = 'Token yenilendi') {
    for (const ws of this.authedClients.keys()) {
      try { ws.close(code, reason); } catch {}
    }
  }

  /** @param {string} reason */
  failPending(reason) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.fail(new Error(reason));
    }
  }

  /** @param {import('ws').WebSocket} ws @param {object} obj */
  send(ws, obj) {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj));
  }

  /**
   * Tarayıcıya istek gönderir; zaman aşımı ve hata yanıtı reject edilir.
   * @param {string} method @param {object} [params] @param {number} [timeoutMs]
   */
  request(method, params = {}, timeoutMs = BROWSER_RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const client = this.activeClient;
      if (!client) {
        reject(new Error('Tarayıcı eklentisi bağlı değil! Eklentide token\'ı girip "Ayarları Kaydet ve Bağlan" butonuna basın.'));
        return;
      }
      const id = 'vsc_' + crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tarayıcı ${timeoutMs / 1000} sn içinde yanıt vermedi (${method}).`));
      }, timeoutMs);
      this.pending.set(id, {
        settle: (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error.message || 'Tarayıcı eklentisi hata döndürdü.'));
          else resolve(msg.result);
        },
        fail: (err) => { clearTimeout(timer); reject(err); }
      });
      this.send(client, { jsonrpc: '2.0', id, method, params });
    });
  }

  /** @param {import('ws').WebSocket} ws @param {string} origin */
  handleConnection(ws, origin) {
    let authed = false;
    let authTimer = setTimeout(() => {
      if (!authed) { try { ws.close(4001, 'Kimlik doğrulama zaman aşımı'); } catch {} }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || msg.method === 'ping') return;

      // Eşleştirme: token'sız eklenti, kullanıcı VS Code'da onaylarsa token'ı alır.
      if (msg.method === 'bridge/pair' && !authed) {
        clearTimeout(authTimer);
        // Kullanıcının yanıt vermesi için süre tanı.
        authTimer = setTimeout(() => { try { ws.close(4001, 'Eşleştirme zaman aşımı'); } catch {} }, 120000);
        const token = this.options.onPairRequest
          ? await this.options.onPairRequest({ client: String(msg.params?.client || 'Tarayıcı eklentisi'), origin })
          : null;
        clearTimeout(authTimer);
        if (token) {
          this.send(ws, { jsonrpc: '2.0', id: msg.id, result: { token, workspace: this.options.getWorkspaceName() } });
        } else {
          this.send(ws, { jsonrpc: '2.0', id: msg.id, error: { code: -32003, message: 'Eşleştirme reddedildi' } });
        }
        ws.close(1000, 'pair done');
        return;
      }

      if (msg.method === 'bridge/authenticate') {
        clearTimeout(authTimer);
        if (!tokensMatch(msg.params?.token)) {
          ui.log('⛔ Geçersiz token ile bağlantı denemesi reddedildi. Token\'ı 🔑 butonuyla kopyalayıp tarayıcı eklentisine yapıştırın.', 'warn');
          this.send(ws, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Geçersiz Token' } });
          ws.close();
          return;
        }
        const workspace = this.options.getWorkspaceName();
        // Tarayıcı belirli bir projeye sabitlenmişse başka pencere bağlantıyı kabul etmez (aktif istemci olmaz).
        const expected = msg.params?.expectedWorkspace;
        if (expected && expected !== workspace) {
          this.send(ws, { jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Farklı proje', data: { workspace } } });
          ws.close(1000, 'workspace mismatch');
          return;
        }
        const result = {
          status: 'authenticated',
          port: this.port,
          workspace,
          limits: this.options.getLimits?.() || null
        };
        // Yoklama (probe): tarayıcı açık VS Code pencerelerini listelerken bağlantı aktif istemci yapılmaz.
        if (msg.params?.probe) {
          this.send(ws, { jsonrpc: '2.0', id: msg.id, result });
          ws.close(1000, 'probe');
          return;
        }
        authed = true;
        this.authedClients.delete(ws);
        this.authedClients.set(ws, String(msg.params?.client || 'Tarayıcı'));
        this.send(ws, { jsonrpc: '2.0', id: msg.id, result });
        this.emitStatus();
        return;
      }

      if (!authed) return;

      // Bizim isteğimize gelen yanıt
      if (msg.id && !msg.method && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        pending?.settle(msg);
        return;
      }

      const notify = this.options.notificationHandlers[msg.method];
      if (notify) {
        try { notify(msg.params || {}); } catch (err) { ui.trace.error(`Bildirim işleyici hatası (${msg.method}): ${err.message}`); }
        return;
      }

      const handler = this.options.requestHandlers[msg.method];
      if (!handler) {
        if (msg.id) this.send(ws, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Bilinmeyen metot: ${msg.method}` } });
        return;
      }
      try {
        const result = await handler(msg.params || {});
        this.send(ws, { jsonrpc: '2.0', id: msg.id, result });
      } catch (err) {
        this.send(ws, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      const wasActive = this.activeClient === ws || this.authedClients.has(ws);
      this.authedClients.delete(ws);
      if (wasActive && !this.activeClient) this.failPending('Tarayıcı bağlantısı koptu.');
      if (wasActive) this.emitStatus();
    });
  }
}

module.exports = { BridgeServer };
