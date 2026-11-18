// @ts-check
'use strict';
const vscode = require('vscode');
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ui = require('./ui');

/**
 * Arka Plan Modu: ayrı ve kalıcı bir Chrome/Chromium profilini NORMAL bir tarayıcı süreci olarak başlatır
 * (otomasyon protokolü / CDP kullanılmaz). Tarayıcı eklentisi bu profilde çalışır ve köprüye bağlanır.
 *  - "visible": giriş yapmak, CAPTCHA geçmek, eklentiyi kurmak/token girmek için görünür pencere.
 *  - "hidden" : Linux'ta Xvfb sanal ekranında; diğer platformlarda ekran dışı pencere.
 * Doğrulama ekranı algılanınca (bridge/attention_required) otomatik olarak görünür moda geçer.
 */

/** @typedef {'stopped' | 'starting' | 'hidden' | 'visible' | 'error'} HostState */

const LINUX_BROWSERS = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'brave', 'microsoft-edge-stable'];
const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
];
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;
const QUICK_EXIT_MS = 4000;

/** @param {string} name */
function findInPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        if (fsSync.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function windowsBrowsers() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const rel = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Chromium\\Application\\chrome.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'Microsoft\\Edge\\Application\\msedge.exe'
  ];
  return roots.flatMap(root => rel.map(r => path.join(/** @type {string} */ (root), r)));
}

/** @returns {string | null} */
function detectBrowserExecutable() {
  const configured = vscode.workspace.getConfiguration('webMcp.browser').get('executablePath', '');
  if (configured) return fsSync.existsSync(configured) ? configured : null;
  if (process.platform === 'linux') {
    for (const name of LINUX_BROWSERS) {
      const found = findInPath(name);
      if (found) return found;
    }
    return null;
  }
  const list = process.platform === 'darwin' ? MAC_BROWSERS : windowsBrowsers();
  return list.find(p => fsSync.existsSync(p)) || null;
}

/** @returns {number | null} */
function findFreeDisplay() {
  for (let n = 99; n < 160; n++) {
    if (!fsSync.existsSync(`/tmp/.X11-unix/X${n}`) && !fsSync.existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  return null;
}

/** @param {number} ms */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class BrowserHost {
  /**
   * @param {{ storagePath: string, extensionPath: string, onStateChange?: (state: HostState, detail?: string) => void }} options
   */
  constructor(options) {
    this.options = options;
    /** @type {HostState} */
    this.state = 'stopped';
    /** @type {import('child_process').ChildProcess | null} */
    this.browserProc = null;
    /** @type {import('child_process').ChildProcess | null} */
    this.xvfbProc = null;
    /** @type {'hidden' | 'visible' | null} */
    this.mode = null;
    this.expectedExit = false;
    /** @type {number[]} */
    this.restartTimes = [];
    this.attentionCooldownUntil = 0;
  }

  get profileDir() {
    return path.join(this.options.storagePath, 'browser-profile');
  }

  /** @param {HostState} state @param {string} [detail] */
  setState(state, detail) {
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }

  isRunning() {
    return !!this.browserProc && this.browserProc.exitCode === null;
  }

  ensureProfileDir() {
    fsSync.mkdirSync(this.profileDir, { recursive: true });
    if (process.platform !== 'win32') {
      // Oturum çerezleri bu klasörde: yalnızca kullanıcı okuyabilsin.
      try { fsSync.chmodSync(this.options.storagePath, 0o700); } catch {}
      fsSync.chmodSync(this.profileDir, 0o700);
    }
  }

  /** Öncelik: ayar → sihirbazın kopyaladığı sabit klasör → paket içi → geliştirme düzeni. */
  resolveBrowserExtensionDir() {
    const configured = vscode.workspace.getConfiguration('webMcp.browser').get('extensionPath', '');
    const candidates = [
      configured,
      path.join(this.options.storagePath, 'browser-extensions', 'chrome'),
      path.join(this.options.extensionPath, 'browser', 'chrome'),
      path.join(this.options.extensionPath, '..', 'extension-chrome')
    ].filter(Boolean);
    return candidates.find(p => fsSync.existsSync(path.join(p, 'manifest.json'))) || null;
  }

  async startXvfb() {
    const xvfb = findInPath('Xvfb');
    if (!xvfb) return null;
    const display = findFreeDisplay();
    if (display === null) return null;
    const proc = spawn(xvfb, [`:${display}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    this.xvfbProc = proc;
    for (let i = 0; i < 30; i++) {
      if (fsSync.existsSync(`/tmp/.X11-unix/X${display}`)) return display;
      if (proc.exitCode !== null) break;
      await sleep(100);
    }
    this.killXvfb();
    return null;
  }

  killXvfb() {
    if (this.xvfbProc && this.xvfbProc.exitCode === null) {
      try { this.xvfbProc.kill('SIGTERM'); } catch {}
    }
    this.xvfbProc = null;
  }

  /** @param {'hidden' | 'visible'} mode */
  async start(mode) {
    if (this.state === 'starting') return;
    if (this.isRunning()) {
      if (this.mode === mode) return;
      await this.stop();
    }

    const exe = detectBrowserExecutable();
    if (!exe) {
      this.setState('error', 'Chrome/Chromium bulunamadı');
      const OPEN = 'Ayarları Aç';
      const pick = await vscode.window.showErrorMessage(
        'Chrome/Chromium bulunamadı. "webMcp.browser.executablePath" ayarına tarayıcı yolunu girin.', OPEN);
      if (pick === OPEN) vscode.commands.executeCommand('workbench.action.openSettings', 'webMcp.browser.executablePath');
      return;
    }

    this.setState('starting');
    this.ensureProfileDir();

    const config = vscode.workspace.getConfiguration('webMcp.browser');
    /** @type {string[]} */
    const startUrls = config.get('startUrls', []);
    const args = [
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Gizli pencerede zamanlayıcılar yavaşlarsa AI yanıtları kaçırılır.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=1280,900'
    ];
    const extDir = this.resolveBrowserExtensionDir();
    // Not: Markalı Chrome 137+ bu bayrağı yok sayar; o durumda eklenti profile bir kez elle kurulur.
    if (extDir) args.push(`--load-extension=${extDir}`);

    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env };
    if (mode === 'hidden') {
      if (process.platform === 'linux') {
        const display = await this.startXvfb();
        if (display !== null) {
          env.DISPLAY = `:${display}`;
          delete env.WAYLAND_DISPLAY;
          args.push('--ozone-platform=x11');
        } else {
          ui.log('⚠️ Xvfb bulunamadı; pencere ekran dışına taşınacak (Wayland\'da görünebilir). Tam gizlilik için "xorg-server-xvfb" paketini kurun.', 'warn');
          args.push('--window-position=-32000,-32000');
        }
      } else {
        args.push('--window-position=-32000,-32000');
      }
    }
    args.push(...(startUrls.length ? startUrls : ['--restore-last-session']));

    this.expectedExit = false;
    this.mode = mode;
    const startedAt = Date.now();
    const proc = spawn(exe, args, { env, stdio: 'ignore', detached: process.platform !== 'win32' });
    this.browserProc = proc;
    ui.trace.info(`Tarayıcı başlatıldı (${mode}): ${exe} ${args.join(' ')}`);

    proc.on('error', (err) => {
      this.setState('error', err.message);
      ui.log(`❌ Tarayıcı başlatılamadı: ${err.message}`, 'error');
    });

    proc.on('exit', (code) => {
      if (this.browserProc !== proc) return;
      this.browserProc = null;
      this.killXvfb();
      if (this.expectedExit) { this.setState('stopped'); return; }

      if (Date.now() - startedAt < QUICK_EXIT_MS && code === 0) {
        // Profil zaten açık bir Chrome tarafından kullanılıyor: yeni süreç isteği ona devredip çıktı.
        this.setState('error', 'Profil başka bir tarayıcı sürecinde açık');
        ui.log('⚠️ Arka plan profili zaten açık bir tarayıcı penceresinde kullanılıyor. O pencereyi kapatıp tekrar deneyin.', 'warn');
        return;
      }
      this.restartTimes = this.restartTimes.filter(t => Date.now() - t < RESTART_WINDOW_MS);
      if (this.restartTimes.length >= MAX_RESTARTS) {
        this.setState('error', 'Tarayıcı tekrar tekrar çöktü');
        ui.log(`❌ Arka plan tarayıcısı ${MAX_RESTARTS} kez çöktü; otomatik yeniden başlatma durduruldu.`, 'error');
        return;
      }
      this.restartTimes.push(Date.now());
      ui.log(`⚠️ Arka plan tarayıcısı beklenmedik şekilde kapandı (kod: ${code}). Yeniden başlatılıyor...`, 'warn');
      setTimeout(() => this.start(this.mode || 'hidden'), 1500);
    });

    this.setState(mode);
    ui.log(mode === 'hidden'
      ? '🕶️ Arka plan tarayıcısı gizli modda başlatıldı.'
      : '🪟 Arka plan tarayıcısı görünür modda açıldı (giriş/doğrulama için). Bitince "Gizli moda geç" komutunu kullanın.');
  }

  async stop() {
    const proc = this.browserProc;
    if (!proc) { this.killXvfb(); this.setState('stopped'); return; }
    this.expectedExit = true;
    const killGroup = (/** @type {NodeJS.Signals} */ sig) => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {}
    };
    killGroup('SIGTERM');
    for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
    if (proc.exitCode === null) killGroup('SIGKILL');
    this.browserProc = null;
    this.killXvfb();
    this.setState('stopped');
  }

  /**
   * İçerik betiği doğrulama/giriş ekranı algıladığında çağrılır.
   * @param {{ reason?: string, url?: string }} params
   */
  async onAttentionRequired(params) {
    const reason = params.reason || 'Doğrulama gerekiyor';
    if (Date.now() < this.attentionCooldownUntil) return;
    this.attentionCooldownUntil = Date.now() + 60000;

    if (this.state !== 'hidden') {
      ui.log(`🧩 ${reason}: tarayıcıda işlemi tamamlayın (${params.url || ''}).`, 'warn');
      return;
    }
    const autoShow = vscode.workspace.getConfiguration('webMcp.browser').get('autoShowOnChallenge', true);
    if (autoShow) {
      ui.log(`🧩 ${reason} — tarayıcı görünür moda alınıyor.`, 'warn');
      await this.start('visible');
      vscode.window.showWarningMessage(`Web-MCP: ${reason}. Tarayıcıda işlemi tamamlayın, ardından "Web-MCP: Arka Plan Tarayıcısını Gizle" komutunu çalıştırın.`);
      return;
    }
    const SHOW = 'Görünür Aç';
    const pick = await vscode.window.showWarningMessage(`Web-MCP: ${reason} (arka plan tarayıcısı).`, SHOW);
    if (pick === SHOW) await this.start('visible');
  }
}

module.exports = { BrowserHost, detectBrowserExecutable, findInPath };
