#!/usr/bin/env node
// Tek dağıtım paketi üretir:
//   dist/web-mcp-<sürüm>.vsix               → VS Code eklentisi (tarayıcı eklentileri İÇİNDE)
//   dist/web-mcp-suite-<sürüm>.zip          → .vsix + install.sh + install.ps1 + KURULUM.md
// İmzalı Firefox eklentisi varsa (dist/firefox-signed.xpi, bkz. scripts/sign-firefox.js) pakete eklenir.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { build } = require('./build-browser');
const { zipDirectory, writeZip } = require('./zip');

const ROOT = path.resolve(__dirname, '..');
const VSCODE_DIR = path.join(ROOT, 'vscode-web-mcp');
const DIST = path.join(ROOT, 'dist');
const { version } = require(path.join(VSCODE_DIR, 'package.json'));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function step(title) {
  console.log(`\n▶ ${title}`);
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

step('Tarayıcı eklentileri üretiliyor');
build();

if (!process.argv.includes('--skip-tests')) {
  step('Testler çalıştırılıyor');
  execFileSync(npm, ['test'], { cwd: VSCODE_DIR, stdio: 'inherit' });
}

step('Tarayıcı eklentileri VS Code paketine ekleniyor');
const bundled = path.join(VSCODE_DIR, 'browser');
fs.rmSync(bundled, { recursive: true, force: true });
copyDir(path.join(ROOT, 'extension-chrome'), path.join(bundled, 'chrome'));
copyDir(path.join(ROOT, 'extension-firefox'), path.join(bundled, 'firefox'));
zipDirectory(path.join(ROOT, 'extension-firefox'), path.join(bundled, 'firefox.xpi'));
const signedXpi = path.join(DIST, 'firefox-signed.xpi');
if (fs.existsSync(signedXpi)) {
  fs.copyFileSync(signedXpi, path.join(bundled, 'firefox-signed.xpi'));
  console.log('  ✔ İmzalı Firefox eklentisi eklendi (kalıcı kurulum).');
} else {
  console.log('  ℹ İmzalı Firefox eklentisi yok → Firefox\'ta geçici kurulum yapılır (bkz. npm run sign:firefox).');
}

step('VS Code eklentisi paketleniyor (.vsix)');
fs.mkdirSync(DIST, { recursive: true });
const vsix = path.join(DIST, `web-mcp-${version}.vsix`);
execFileSync(npx, ['--yes', '@vscode/vsce@3', 'package', '--skip-license', '--allow-missing-repository', '--out', vsix], {
  cwd: VSCODE_DIR,
  stdio: 'inherit'
});

step('Dağıtım arşivi oluşturuluyor');
const installers = path.join(__dirname, 'installers');
const bundleName = `web-mcp-suite-${version}`;
writeZip([
  { rel: `${bundleName}/web-mcp-${version}.vsix`, full: vsix },
  { rel: `${bundleName}/install.sh`, full: path.join(installers, 'install.sh'), mode: 0o755 },
  { rel: `${bundleName}/install.ps1`, full: path.join(installers, 'install.ps1') },
  { rel: `${bundleName}/install.cmd`, full: path.join(installers, 'install.cmd') },
  { rel: `${bundleName}/KURULUM.md`, full: path.join(installers, 'KURULUM.md') }
], path.join(DIST, `${bundleName}.zip`));

console.log(`\n✅ Hazır:\n  ${path.relative(process.cwd(), vsix)}\n  ${path.relative(process.cwd(), path.join(DIST, bundleName + '.zip'))}`);
