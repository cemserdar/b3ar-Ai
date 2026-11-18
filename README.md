# ⚡ Web-to-MCP Multi-Agent Bridge

Tarayıcıda açık AI web arayüzlerini (**ChatGPT, Claude, Gemini, Google AI Mode, AI Studio, DeepSeek, Kimi, GLM, Qwen, Grok, Mistral, Perplexity** vb.) API anahtarı gerektirmeden **VS Code** içinde dosya sistemine, terminale ve diff araçlarına erişebilen bir **çoklu ajan kodlama sistemine** dönüştürür.

---

## 🚀 Kurulum (tek paket)

`web-mcp-suite-<sürüm>.zip` arşivini açın:

| Sistem | Komut |
|---|---|
| Linux / macOS | `./install.sh` |
| Windows | `install.cmd` (çift tık) |

1. Betik VS Code eklentisini kurar (tarayıcı eklentileri paketin **içindedir**) ve VS Code'u açar.
2. VS Code'da **"Web-MCP kuruldu!" → Kurulumu Başlat**: sihirbaz yüklü tarayıcıları bulur ve eklentiyi kurdurur.
3. Tarayıcı eklentisi kurulunca VS Code'da **eşleştirme onayı** çıkar → **İzin Ver**. Token otomatik aktarılır.

Ayrıntılar: [web-mcp-suite/scripts/installers/KURULUM.md](web-mcp-suite/scripts/installers/KURULUM.md)

> **Tarayıcı kısıtları:** Chrome mağaza dışı eklentiyi sessizce kurmaya izin vermez — sihirbaz eklentiler sayfasını açar ve klasör yolunu panoya kopyalar ("Paketlenmemiş öğe yükle", tek seferlik). Firefox yalnızca **Mozilla imzalı** `.xpi`'yi kalıcı kurar; imza için `npm run sign:firefox` (ücretsiz AMO hesabı).

---

## 🏗️ Mimari

```text
┌──────────────────────── VS Code Eklentisi (vscode-web-mcp) ────────────────────────┐
│ webviewProvider  Sohbet paneli, @dosya, Kabul Et / Reddet                           │
│ bridgeServer     127.0.0.1 WebSocket · JSON-RPC 2.0 · Origin + token · eşleştirme   │
│ tools            read_file / write_file / apply_diff / list_directory / run_command │
│ diffEngine       Güvenli search/replace (CRLF, belirsizlik kontrolü)                 │
│ browserHost      Arka plan modu: ayrı profil, Xvfb ile gizli tarayıcı                │
│ setupWizard      Tarayıcı tespiti ve eklenti kurulumu                                │
└───────────────────────────────────────▲─────────────────────────────────────────────┘
                                        │ ws://127.0.0.1:8766-8770, 8765
┌───────────────────── Tarayıcı Eklentisi (src/browser → Chrome & Firefox) ──────────┐
│ background  Bağlantı, eşleştirme, istek kotası, sekme rolleri, Auto-Failover        │
│ content     Site adaptörleri, <mcp_call> ayrıştırma, doğrulama/giriş algılama       │
│ popup       Mod seçimi, VS Code projesi seçimi, eşleştirme                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Klasör yapısı

```text
web-mcp-suite/
├── src/browser/            # Tarayıcı eklentisi TEK KAYNAK (buradan düzenleyin)
├── extension-chrome/       # Üretilir: npm run build
├── extension-firefox/      # Üretilir: npm run build
├── vscode-web-mcp/
│   ├── extension.js        # Bağlantı noktası (activate/deactivate)
│   ├── lib/                # Modüller
│   ├── media/webview.html
│   └── test/               # node:test (bağımlılıksız)
└── scripts/                # build, package, sign-firefox, zip, installers/
```

---

## 🛡️ Güvenlik

- **Token:** Kurulum başına rastgele üretilir, VS Code SecretStorage'da saklanır; eşleştirme yalnızca VS Code'daki onayla verilir.
- **Origin:** Sunucu yalnızca `chrome-extension://` / `moz-extension://` bağlantılarını kabul eder (web sayfaları bağlanamaz).
- **Dosya erişimi:** Workspace dışı, sembolik bağlantı kaçışı ve `.git/` engellenir.
- **Terminal:** AI'ın her komutu çalışmadan önce VS Code'da onayınıza sunulur.
- **Webview:** Nonce'lu CSP; AI içeriği yalnızca düz metin olarak basılır.
- **Hesap güvenliği:** AI sekmelerine otomatik gönderim kotası (`webMcp.limits.*`, varsayılan 60/saat, 400/gün, 3 sn aralık).

> AI sitelerinin kullanım koşulları otomatik erişimi kısıtlayabilir. Bu araç bot korumasını atlatmaya çalışmaz; doğrulama ekranı çıkarsa tarayıcıyı size gösterir.

---

## 🕶️ Arka Plan Modu

Ayrı ve kalıcı bir Chromium profili **normal bir tarayıcı süreci** olarak açılır (otomasyon protokolü yok).
Linux'ta Xvfb sanal ekranında tamamen görünmez çalışır (`chromium` + `xorg-server-xvfb`).

Durum çubuğu → **Web-MCP** menüsü: *Görünür aç* (bir kez giriş yapın) → *Gizli başlat*.
Ayarlar: `webMcp.browser.*` (tarayıcı yolu, açılış adresleri, VS Code ile otomatik başlatma, doğrulamada otomatik gösterme).

---

## 🧑‍💻 Geliştirme

```bash
cd web-mcp-suite
npm ci --prefix vscode-web-mcp
npm run build        # src/browser → extension-chrome / extension-firefox
npm run check        # build güncel mi + tüm testler
npm run lint:firefox # Mozilla web-ext lint
npm run package      # dist/web-mcp-<sürüm>.vsix + dist/web-mcp-suite-<sürüm>.zip
```

Tarayıcı eklentisi dosyalarını **yalnızca `src/browser/` altında** düzenleyin; `extension-*` klasörleri üretilir (CI güncelliğini denetler).
