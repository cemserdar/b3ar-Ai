// @ts-check
'use strict';
const vscode = require('vscode');
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { findInPath } = require('./browserHost');
const ui = require('./ui');

/**
 * Kurulum sihirbazı. VS Code eklentisi (.vsix) tarayıcı eklentilerini de içinde taşır; sihirbaz:
 *  1) Paketlenmiş eklentileri sabit bir klasöre kopyalar (sürüm değişince günceller),
 *  2) Yüklü tarayıcıları bulur ve her biri için kurulumu mümkün olan en az tıklamayla başlatır,
 *  3) Eklenti kurulunca otomatik eşleştirme isteği VS Code'a gelir (token kopyalamaya gerek yok).
 *
 * Tarayıcı kısıtları: Chrome mağaza dışı eklentiyi sessizce kurmaya izin vermez ("Paketlenmemiş öğe yükle" gerekir);
 * Firefox yalnızca Mozilla imzalı .xpi dosyasını kalıcı kurar (imzasızsa geçici kurulum yapılır).
 */

/** @typedef {{ id: string, name: string, family: 'chromium' | 'firefox', exe: string }} DetectedBrowser */

const CANDIDATES = {
  linux: [
    ['google-chrome-stable', 'Google Chrome', 'chromium'],
    ['google-chrome', 'Google Chrome', 'chromium'],
    ['chromium', 'Chromium', 'chromium'],
    ['chromium-browser', 'Chromium', 'chromium'],
    ['brave', 'Brave', 'chromium'],
    ['brave-browser', 'Brave', 'chromium'],
    ['microsoft-edge-stable', 'Microsoft Edge', 'chromium'],
    ['vivaldi-stable', 'Vivaldi', 'chromium'],
    ['firefox', 'Firefox', 'firefox'],
    ['firefox-developer-edition', 'Firefox Developer Edition', 'firefox'],
    ['librewolf', 'LibreWolf', 'firefox'],
    ['zen-browser', 'Zen Browser', 'firefox'],
    ['zen', 'Zen Browser', 'firefox'],
    ['waterfox', 'Waterfox', 'firefox']
  ],
  darwin: [
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome', 'chromium'],
    ['/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium', 'chromium'],
    ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave', 'chromium'],
    ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge', 'chromium'],
    ['/Applications/Firefox.app/Contents/MacOS/firefox', 'Firefox', 'firefox'],
    ['/Applications/LibreWolf.app/Contents/MacOS/librewolf', 'LibreWolf', 'firefox'],
    ['/Applications/Zen Browser.app/Contents/MacOS/zen', 'Zen Browser', 'firefox']
  ],
  win32: [
    ['Google\\Chrome\\Application\\chrome.exe', 'Google Chrome', 'chromium'],
    ['BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Brave', 'chromium'],
    ['Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge', 'chromium'],
    ['Mozilla Firefox\\firefox.exe', 'Firefox', 'firefox'],
    ['LibreWolf\\librewolf.exe', 'LibreWolf', 'firefox'],
    ['Zen Browser\\zen.exe', 'Zen Browser', 'firefox']
  ]
};

/** @returns {DetectedBrowser[]} */
function detectBrowsers() {
  /** @type {DetectedBrowser[]} */
  const found = [];
  const seen = new Set();
  const add = (exe, name, family) => {
    let real = exe;
    try { real = fsSync.realpathSync(exe); } catch {}
    if (seen.has(real) || found.some(b => b.name === name)) return;
    seen.add(real);
    found.push({ id: `${family}:${name}`, name, family, exe });
  };

  if (process.platform === 'linux') {
    for (const [bin, name, family] of CANDIDATES.linux) {
      const exe = findInPath(bin);
      if (exe) add(exe, name, family);
    }
  } else if (process.platform === 'darwin') {
    for (const [exe, name, family] of CANDIDATES.darwin) if (fsSync.existsSync(exe)) add(exe, name, family);
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const [rel, name, family] of CANDIDATES.win32) {
      for (const root of roots) {
        const exe = path.join(/** @type {string} */ (root), rel);
        if (fsSync.existsSync(exe)) { add(exe, name, family); break; }
      }
    }
  }
  return found;
}

/** Paketlenmiş (browser/) veya geliştirme düzenindeki (../extension-*) eklenti kaynakları. */
function bundledSources(extensionPath) {
  const pick = (...dirs) => dirs.find(d => fsSync.existsSync(path.join(d, 'manifest.json'))) || null;
  const pickFile = (...files) => files.find(f => fsSync.existsSync(f)) || null;
  return {
    chrome: pick(path.join(extensionPath, 'browser', 'chrome'), path.join(extensionPath, '..', 'extension-chrome')),
    firefox: pick(path.join(extensionPath, 'browser', 'firefox'), path.join(extensionPath, '..', 'extension-firefox')),
    firefoxSignedXpi: pickFile(path.join(extensionPath, 'browser', 'firefox-signed.xpi'), path.join(extensionPath, '..', 'dist', 'firefox-signed.xpi')),
    firefoxXpi: pickFile(path.join(extensionPath, 'browser', 'firefox.xpi'))
  };
}

/** @param {string} storagePath */
function installedDirs(storagePath) {
  const base = path.join(storagePath, 'browser-extensions');
  return { base, chrome: path.join(base, 'chrome'), firefox: path.join(base, 'firefox'), xpi: path.join(base, 'web-mcp-firefox.xpi') };
}

/** @param {string} dir */
function manifestVersion(dir) {
  try { return JSON.parse(fsSync.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version; } catch { return null; }
}

/**
 * Paketlenmiş tarayıcı eklentilerini sabit klasöre kopyalar. Chrome "paketlenmemiş" eklentiyi bu klasörden
 * yüklediği için VS Code eklentisi güncellenince tarayıcıda yalnızca "Yeniden yükle" yeterli olur.
 * @param {string} extensionPath @param {string} storagePath
 */
function syncBundledExtensions(extensionPath, storagePath) {
  const src = bundledSources(extensionPath);
  const dst = installedDirs(storagePath);
  fsSync.mkdirSync(dst.base, { recursive: true });
  let updated = false;
  for (const key of /** @type {const} */ (['chrome', 'firefox'])) {
    const from = src[key];
    if (!from) continue;
    if (manifestVersion(from) !== manifestVersion(dst[key]) || !fsSync.existsSync(dst[key])) {
      fsSync.rmSync(dst[key], { recursive: true, force: true });
      fsSync.cpSync(from, dst[key], { recursive: true });
      updated = true;
    }
  }
  const xpi = src.firefoxSignedXpi || src.firefoxXpi;
  if (xpi) fsSync.copyFileSync(xpi, dst.xpi);
  return { ...dst, hasXpi: !!xpi, xpiSigned: !!src.firefoxSignedXpi, updated };
}

/** @param {string} exe @param {string[]} args */
function launch(exe, args) {
  const proc = spawn(exe, args, { detached: true, stdio: 'ignore' });
  proc.on('error', (err) => ui.log(`⚠️ Tarayıcı açılamadı (${exe}): ${err.message}`, 'warn'));
  proc.unref();
}

/** @param {string} message @param {string} detail @param {string[]} buttons */
async function step(message, detail, ...buttons) {
  return vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons);
}

/** @param {DetectedBrowser} b @param {ReturnType<typeof syncBundledExtensions>} dirs */
async function setupChromium(b, dirs) {
  await vscode.env.clipboard.writeText(dirs.chrome);
  launch(b.exe, ['chrome://extensions/']);
  const OPEN = 'Klasörü Göster';
  const choice = await step(
    `${b.name}: eklentiyi yükleyin`,
    [
      `${b.name} eklentiler sayfası açıldı. Klasör yolu panoya kopyalandı:`,
      dirs.chrome,
      '',
      '1) Sağ üstten "Geliştirici modu"nu açın.',
      '2) "Paketlenmemiş öğe yükle" butonuna basın.',
      '3) Açılan pencerede Ctrl+L ile yolu yapıştırıp Enter → "Seç".',
      '',
      'Eklenti yüklenince VS Code\'da eşleştirme onayı çıkacak: "İzin Ver" deyin.',
      '(Chrome, mağaza dışı eklentileri sessizce kurmaya izin vermediği için bu adım elle yapılır.)'
    ].join('\n'),
    'Tamam',
    OPEN
  );
  if (choice === OPEN) vscode.env.openExternal(vscode.Uri.file(dirs.chrome));
}

/** @param {DetectedBrowser} b @param {ReturnType<typeof syncBundledExtensions>} dirs */
async function setupFirefox(b, dirs) {
  const isLibreWolf = /librewolf/i.test(b.name);
  if (dirs.hasXpi && (dirs.xpiSigned || isLibreWolf)) {
    launch(b.exe, [dirs.xpi]);
    await step(
      `${b.name}: eklentiyi onaylayın`,
      `${b.name} kurulum isteği açıldı. Çıkan pencerede "Ekle" butonuna basın.\n\nEklenti kurulunca VS Code'da eşleştirme onayı çıkacak: "İzin Ver" deyin.`,
      'Tamam'
    );
    return;
  }
  const manifestPath = path.join(dirs.firefox, 'manifest.json');
  await vscode.env.clipboard.writeText(manifestPath);
  launch(b.exe, ['about:debugging#/runtime/this-firefox']);
  await step(
    `${b.name}: eklentiyi yükleyin (geçici)`,
    [
      'Bu pakette Mozilla imzalı .xpi yok; Firefox imzasız eklentiyi yalnızca GEÇİCİ olarak yükler (tarayıcı kapanınca silinir).',
      'Kalıcı kurulum için paketi imzalı .xpi ile oluşturun (README: "Firefox imzalama").',
      '',
      `manifest.json yolu panoya kopyalandı:\n${manifestPath}`,
      '',
      '1) Açılan sayfada "Geçici Eklenti Yükle..." butonuna basın.',
      '2) Ctrl+L ile yolu yapıştırıp Enter.',
      '',
      'Eklenti yüklenince VS Code\'da eşleştirme onayı çıkacak: "İzin Ver" deyin.'
    ].join('\n'),
    'Tamam'
  );
}

/**
 * @param {{ extensionPath: string, storagePath: string, browserHost: import('./browserHost').BrowserHost, version: string, globalState: import('vscode').Memento }} deps
 */
async function runSetupWizard(deps) {
  const dirs = syncBundledExtensions(deps.extensionPath, deps.storagePath);
  if (!fsSync.existsSync(dirs.chrome) && !fsSync.existsSync(dirs.firefox)) {
    vscode.window.showErrorMessage('Web-MCP: Paket içinde tarayıcı eklentisi bulunamadı. Paketi "npm run package" ile yeniden oluşturun.');
    return;
  }

  const browsers = detectBrowsers();
  /** @type {(import('vscode').QuickPickItem & { browser?: DetectedBrowser, background?: boolean })[]} */
  const items = browsers.map(b => ({
    label: `${b.family === 'firefox' ? '$(flame)' : '$(globe)'} ${b.name}`,
    description: b.exe,
    picked: true,
    browser: b
  }));
  if (browsers.some(b => b.family === 'chromium')) {
    items.push({
      label: '$(eye-closed) Arka plan modunu hazırla (ayrı, gizli çalışabilen tarayıcı profili)',
      description: 'AI sitelerine bir kez giriş yapmanız gerekir',
      picked: false,
      background: true
    });
  }
  if (items.length === 0) {
    vscode.window.showWarningMessage('Web-MCP: Desteklenen bir tarayıcı bulunamadı (Chrome, Chromium, Brave, Edge, Firefox, LibreWolf, Zen).');
    return;
  }

  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Web-MCP Kurulum Sihirbazı',
    placeHolder: 'Eklentinin kurulacağı tarayıcıları seçin'
  });
  if (!picks || picks.length === 0) return;

  for (const pick of picks) {
    if (!pick.browser) continue;
    if (pick.browser.family === 'chromium') await setupChromium(pick.browser, dirs);
    else await setupFirefox(pick.browser, dirs);
  }

  if (picks.some(p => p.background)) {
    await step(
      'Arka plan modu: ilk kurulum',
      [
        'Ayrı bir tarayıcı profili GÖRÜNÜR olarak açılacak. Bu profilde bir kez:',
        '1) Eklenti otomatik yüklenmediyse (markalı Chrome 137+) eklentiler sayfasından aynı klasörü yükleyin.',
        '2) Kullanmak istediğiniz AI sitelerine (ChatGPT, Gemini, Claude...) giriş yapın.',
        '3) VS Code\'daki eşleştirme onayına "İzin Ver" deyin.',
        '',
        'Sonra durum çubuğundaki Web-MCP menüsünden "Gizli başlat"ı seçin.',
        'Not: AI sitelerinin kullanım koşulları otomasyonu kısıtlayabilir; istek kotası ayarlarını (webMcp.limits) düşük tutun.'
      ].join('\n'),
      'Başlat'
    ) === 'Başlat' && await deps.browserHost.start('visible');
  }

  await deps.globalState.update('setupCompletedVersion', deps.version);
  ui.log('✅ Kurulum sihirbazı tamamlandı. Tarayıcı eklentisi kurulunca eşleştirme onayı gelecek.');
}

/**
 * Aktivasyonda çağrılır: eklentileri senkronlar, ilk kurulumda/sürüm değişince sihirbazı önerir.
 * @param {Parameters<typeof runSetupWizard>[0]} deps
 */
async function onActivate(deps) {
  let dirs;
  try {
    dirs = syncBundledExtensions(deps.extensionPath, deps.storagePath);
  } catch (err) {
    ui.trace.error(`Tarayıcı eklentisi senkronizasyonu başarısız: ${err.message}`);
    return;
  }
  const completed = deps.globalState.get('setupCompletedVersion');
  if (!completed) {
    const START = 'Kurulumu Başlat';
    const pick = await vscode.window.showInformationMessage(
      'Web-MCP kuruldu! Tarayıcı eklentilerini kurmak için sihirbazı başlatın.', START, 'Daha Sonra');
    if (pick === START) await runSetupWizard(deps);
  } else if (completed !== deps.version && dirs.updated) {
    vscode.window.showInformationMessage(
      `Web-MCP ${deps.version} sürümüne güncellendi. Tarayıcıdaki eklentiyi yenileyin (Chrome: eklentiler sayfasında ↻; Firefox: yeniden kurun).`);
    await deps.globalState.update('setupCompletedVersion', deps.version);
  }
}

module.exports = { runSetupWizard, onActivate, detectBrowsers, syncBundledExtensions, installedDirs };
