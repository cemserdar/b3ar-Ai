// @ts-check
'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const { TOKEN_SECRET_KEY } = require('./constants');

/** @type {string | null} */
let authToken = null;
const sessionApprovedCommands = new Set();

/**
 * Token kurulum başına rastgele üretilir ve VS Code SecretStorage içinde saklanır.
 * @param {import('vscode').ExtensionContext} context
 * @param {boolean} [forceNew]
 */
async function loadOrCreateToken(context, forceNew = false) {
  let token = forceNew ? undefined : await context.secrets.get(TOKEN_SECRET_KEY);
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    await context.secrets.store(TOKEN_SECRET_KEY, token);
  }
  authToken = token;
  return token;
}

/** Sabit-zamanlı karşılaştırma. @param {unknown} given */
function tokensMatch(given) {
  if (!authToken || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function copyTokenToClipboard() {
  if (!authToken) return;
  await vscode.env.clipboard.writeText(authToken);
  vscode.window.showInformationMessage('🔑 Bağlantı token\'ı panoya kopyalandı. Tarayıcı eklentisinin ayarlarına yapıştırıp "Ayarları Kaydet ve Bağlan" butonuna basın.');
}

/**
 * AI'ın istediği terminal komutu için modal onay. "Bu oturumda hep izin ver" yalnızca birebir aynı komut içindir.
 * @param {string} command @param {string} cwd
 */
async function confirmCommand(command, cwd) {
  if (sessionApprovedCommands.has(command)) return true;
  const RUN = 'Çalıştır';
  const ALWAYS = 'Bu oturumda hep izin ver';
  const choice = await vscode.window.showWarningMessage(
    'AI bir terminal komutu çalıştırmak istiyor',
    { modal: true, detail: `Komut:\n${command}\n\nÇalışma dizini: ${cwd}` },
    RUN,
    ALWAYS
  );
  if (choice === ALWAYS) sessionApprovedCommands.add(command);
  return choice === RUN || choice === ALWAYS;
}

let pairingInProgress = false;
/** origin → reddedilme zamanı (aynı eklentinin onay penceresini art arda açmasını engeller) */
const pairDeniedAt = new Map();
const PAIR_DENY_COOLDOWN_MS = 60000;

/**
 * Tarayıcı eklentisinin eşleştirme isteği: kullanıcı onaylarsa token döner.
 * Aynı anda tek istek; reddedilen origin 1 dk boyunca tekrar soramaz.
 * @param {{ client: string, origin: string }} info
 * @returns {Promise<string | null>}
 */
async function handlePairRequest({ client, origin }) {
  if (!authToken || pairingInProgress) return null;
  if (Date.now() - (pairDeniedAt.get(origin) || 0) < PAIR_DENY_COOLDOWN_MS) return null;
  pairingInProgress = true;
  try {
    const ALLOW = 'İzin Ver';
    const choice = await vscode.window.showInformationMessage(
      'Bir tarayıcı eklentisi Web-MCP\'ye bağlanmak istiyor',
      {
        modal: true,
        detail: `Eklenti: ${client}\nKaynak: ${origin}\n\nBu isteği siz başlatmadıysanız reddedin. İzin verilen eklenti proje dosyalarınızı okuyup değiştirebilir (komutlar yine onayınıza sunulur).`
      },
      ALLOW
    );
    if (choice === ALLOW) return authToken;
    pairDeniedAt.set(origin, Date.now());
    return null;
  } finally {
    pairingInProgress = false;
  }
}

module.exports = { loadOrCreateToken, tokensMatch, copyTokenToClipboard, confirmCommand, handlePairRequest };
