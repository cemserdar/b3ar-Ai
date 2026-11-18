#!/usr/bin/env bash
# Web-MCP Suite kurulum betiği (Linux / macOS)
#  1) VS Code eklentisini (.vsix) kurar — tarayıcı eklentileri bu paketin içindedir.
#  2) (İsteğe bağlı) Arka plan modu için Chromium + Xvfb kurulumunu önerir.
#  3) VS Code'u açar; "Kurulumu Başlat" bildirimi tarayıcı eklentilerini kurar.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSIX="$(ls "$DIR"/web-mcp-*.vsix 2>/dev/null | head -n1 || true)"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

[ -n "$VSIX" ] || fail "web-mcp-*.vsix dosyası bu klasörde bulunamadı."

# --- VS Code ailesi CLI tespiti -------------------------------------------------
CLI=""
for c in code code-insiders codium cursor windsurf; do
  if command -v "$c" >/dev/null 2>&1; then CLI="$c"; break; fi
done
if [ -z "$CLI" ] && [ "$(uname)" = "Darwin" ]; then
  for app in "Visual Studio Code" "Visual Studio Code - Insiders" "VSCodium" "Cursor"; do
    bin="/Applications/$app.app/Contents/Resources/app/bin/code"
    [ -x "$bin" ] && { CLI="$bin"; break; }
  done
fi
[ -n "$CLI" ] || fail "VS Code komut satırı aracı (code) bulunamadı. VS Code'u kurun veya Komut Paleti → 'Shell Command: Install code command in PATH'."

say "VS Code eklentisi kuruluyor ($CLI)..."
"$CLI" --install-extension "$VSIX" --force
ok "VS Code eklentisi kuruldu."

# --- Arka plan modu bağımlılıkları (yalnızca Linux, isteğe bağlı) -------------------
if [ "$(uname)" = "Linux" ] && [ -t 0 ]; then
  have_chromium=0
  for b in chromium chromium-browser google-chrome-stable google-chrome brave brave-browser microsoft-edge-stable; do
    command -v "$b" >/dev/null 2>&1 && { have_chromium=1; break; }
  done
  have_xvfb=0; command -v Xvfb >/dev/null 2>&1 && have_xvfb=1

  if [ $have_chromium -eq 0 ] || [ $have_xvfb -eq 0 ]; then
    pkgs=()
    if command -v pacman >/dev/null 2>&1; then
      [ $have_chromium -eq 0 ] && pkgs+=(chromium); [ $have_xvfb -eq 0 ] && pkgs+=(xorg-server-xvfb)
      install_cmd=(sudo pacman -S --needed "${pkgs[@]}")
    elif command -v apt-get >/dev/null 2>&1; then
      [ $have_chromium -eq 0 ] && pkgs+=(chromium); [ $have_xvfb -eq 0 ] && pkgs+=(xvfb)
      install_cmd=(sudo apt-get install -y "${pkgs[@]}")
    elif command -v dnf >/dev/null 2>&1; then
      [ $have_chromium -eq 0 ] && pkgs+=(chromium); [ $have_xvfb -eq 0 ] && pkgs+=(xorg-x11-server-Xvfb)
      install_cmd=(sudo dnf install -y "${pkgs[@]}")
    else
      install_cmd=()
    fi

    echo
    warn "Arka plan (gizli tarayıcı) modu için Chromium tabanlı tarayıcı ve Xvfb önerilir."
    if [ ${#install_cmd[@]} -gt 0 ]; then
      read -r -p "Şimdi kurulsun mu? (${install_cmd[*]}) [e/H] " answer
      case "$answer" in
        e|E|y|Y) "${install_cmd[@]}" && ok "Arka plan modu bağımlılıkları kuruldu." ;;
        *) echo "Atlandı. Daha sonra: ${install_cmd[*]}" ;;
      esac
    else
      echo "Paket yöneticiniz için Chromium ve Xvfb paketlerini elle kurun."
    fi
  fi
fi

echo
say "VS Code açılıyor. Sağ alttaki 'Web-MCP kuruldu!' bildiriminde 'Kurulumu Başlat'a tıklayın."
"$CLI" >/dev/null 2>&1 &
ok "Kurulum tamamlandı."
