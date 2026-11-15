# ⚡ Web-to-MCP Multi-Agent Bridge

Tarayıcıda açık olan ücretsiz veya mevcut AI web arayüzlerini (**Claude, ChatGPT, Gemini, Google AI Mode, AI Studio, DeepSeek, Kimi, GLM, Qwen, Grok, Mistral, Perplexity** vb.) ek bir API anahtarına ihtiyaç duymadan **VS Code** içinde yerel dosya sistemine, terminale ve Diff (fark) araçlarına erişebilen otonom bir **Çoklu Ajan (Multi-Agent) Kodlama Sistemine** dönüştüren köprü mimarisidir.

---

## 🏗️ Sistem Mimarisi

Sistem, yerel WebSocket (`ws://127.0.0.1:8765`) üzerinden **JSON-RPC 2.0** ve **XML Tool-Calling** protokolleriyle haberleşen 3 ana bileşenden oluşur:

```text
+-----------------------------------------------------------------------+
|                     VS CODE EKLENTİSİ (vscode-web-mcp)                |
|  - Sol Panel Sohbet Arayüzü (Webview) & @dosya Otomatik Tamamlama     |
|  - Gömülü WebSocket Sunucusu (Port 8765)                              |
|  - Yerel MCP Araçları (read_file, write_file, apply_diff, run_command)|
|  - Native Kırmızı/Yeşil Diff Önizleme & Kabul Et / Reddet Kontrolü    |
+-----------------------------------------------------------------------+
                                 |  ▲
                                 |  | WebSocket (ws://127.0.0.1:8765)
                                 ▼  |
+-----------------------------------------------------------------------+
|             TARAYICI EKLENTİLERİ (extension-chrome / firefox)         |
|  - Prompt Enjeksiyonu & İnsansı Gecikme ile Otomatik Gönderim         |
|  - DOM Gözlemcisi (MutationObserver) ile AI Yanıtlarını Okuma         |
|  - Çoklu Sekme Orkestrasyonu (Mimar ➔ Kodlayıcı ➔ Denetçi)            |
|  - Auto-Failover: Kota/Hata durumunda sıradaki AI sekmesine geçiş     |
+-----------------------------------------------------------------------+
Klasör YapısıPlaintextweb-mcp-suite/
├── README.md                # Proje dokümantasyonu ve kullanım kılavuzu
├── vscode-web-mcp/          # VS Code Eklentisi (Gömülü Sunucu + UI)
│   ├── package.json
│   ├── extension.js
│   └── media/
│       └── icon.svg
├── extension-chrome/        # Chrome / Brave / Edge Eklentisi (Manifest V3)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   └── popup.js
└── extension-firefox/       # Firefox / Zen / LibreWolf Eklentisi (Manifest V3)
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── popup.html
    └── popup.js
🚀 Kurulum Adımları1. VS Code Eklentisinin KurulumuTerminali açın ve vscode-web-mcp klasörüne girerek tek bağımlılık olan ws paketini yükleyin:Bashcd web-mcp-suite/vscode-web-mcp
npm install
Eklentiyi VS Code'un eklentiler dizinine sembolik bağ (symlink) ile bağlayın:Bashln -s "$(pwd)" ~/.vscode/extensions/vscode-web-mcp
VS Code'u yeniden başlatın. Sol dikey menü çubuğunda (Activity Bar) ⚡ Web-MCP Agent ikonu görünecektir. VS Code açıldığı anda 8765 portu arka planda otomatik olarak dinlemeye başlar.2. Tarayıcı Eklentisinin KurulumuChrome / Brave / Edge İçinAdres çubuğuna chrome://extensions yazın.Sağ üstten Geliştirici modu (Developer mode) anahtarını açın.Paketlenmemiş öğe yükle (Load unpacked) butonuna tıklayın ve extension-chrome/ klasörünü seçin.Firefox / Zen Browser İçinAdres çubuğuna about:debugging#/runtime/this-firefox yazın.Geçici Eklenti Yükle... (Load Temporary Add-on...) butonuna tıklayın.extension-firefox/manifest.json dosyasını seçin.🎮 Kullanım KılavuzuAdım 1: Bağlantıyı EşleştirmeTarayıcınızda kullanmak istediğiniz AI sitelerini açın (örneğin 1. sekmede Claude veya Gemini, 2. sekmede DeepSeek veya Qwen).Not: Eklentiyi yüklemeden önce açık olan AI sekmeleri varsa bir kez F5 ile sayfayı yenileyin.Tarayıcı araç çubuğundan eklenti ikonuna tıklayın. Varsayılan adres (ws://127.0.0.1:8765) ve token (mcp-gizli-anahtar-2026) hazır gelir; Ayarları Kaydet ve Bağlan butonuna basın.VS Code sol panelindeki rozetin yeşile dönüp Tarayıcı Bağlı yazdığını doğrulayın.Adım 2: Çalışma Modunu SeçmeHem VS Code panelinden hem de tarayıcı eklentisi popup'ından 3 farklı iş akışı seçebilirsiniz:Modİş AkışıAçıklamaMod 1: Tekli OtonomTek AI SekmesiAktif sekmedeki AI hem planlar hem kod yazar. Günlük hızlı işler için idealdir.Mod 2: Mimar ➔ KodlayıcıSekme A $\rightarrow$ Sekme BMimar sekmesi projeyi inceler, uygulama kodu yazmadan .mcp/PLAN.md dosyasını hazırlar ve <handoff_to_coder/> ürettiği an sistem otomatik olarak Kodlayıcı sekmesine geçip kodu yazdırır.Mod 3: Planla ➔ Kodla ➔ DenetleSekme A $\rightarrow$ Sekme B $\rightarrow$ Sekme AKodlayıcı işi bitirip <handoff_to_reviewer/> dediğinde sistem tekrar Mimar sekmesine döner; Mimar değişiklikleri denetler, hata varsa tekrar Kodlayıcıya geri gönderir.(Mod 2 veya Mod 3 kullanırken tarayıcı eklentisi popup'ından Mimar Sekmesi ve Kodlayıcı Sekmesi seçimini yapıp kaydetmeyi unutmayın.)Adım 3: VS Code Üzerinden Görev GöndermeNormal Sohbet: Alt kutuya doğrudan mesajınızı yazıp Enter tuşuna bastığınızda (örneğin selam), tarayıcıya sadece yazdığınız metin gider.Ajan Modunu Aktifleştirme: AI'ın proje dosyalarınızı okuyup değiştirmesini istediğinizde, yeni bir sohbet sekmesinde bir kez üstteki 🧠 Ajan Kurallarını AI'a Yükle butonuna basın. Bu işlem MCP araç kurallarını ve proje hafızasını AI'a tanıtır.Dosya Bağlamı Ekleme (@dosya): Mesaj yazarken @ tuşuna bastığınızda proje dosyaları listelenir. Seçtiğiniz dosyalar rozet (chip) olarak eklenir ve tam içerikleri AI'a iletilir. İsterseniz "Açık olan dosyayı da gönder" kutucuğunu işaretleyebilirsiniz.Adım 4: Diff İnceleme ve OnaylamaAI herhangi bir dosyayı oluşturduğunda veya güncellediğinde VS Code orta ekranda otomatik olarak Kırmızı/Yeşil yan yana Diff (Eski ↔ Yeni) penceresi açar.Sol panelde beliren dosya kartından:✔ Kabul Et: Değişikliği onaylar, geçici diff sekmesini kapatır ve dosyayı temiz haliyle açar.✖ Reddet (Geri Al): Dosyayı değişiklikten önceki haline döndürür (yeni oluşturulan bir dosyaysa siler).🛡️ Akıllı Özellikler ve GüvenlikOtomatik Yedekleme (Auto-Failover): Aktif AI sekmesinde mesaj limiti dolduğunda (usage limit, quota exceeded, too many requests vb.) veya ağ hatası oluştuğunda eklenti duraksamaz; tarayıcıda açık olan bir sonraki AI sekmesine otomatik atlar, mevcut rolü ve .mcp/STATE.md hafızasını yeni sekmeye devrederek kaldığı yerden devam eder.Canlı Proje Hafızası (.mcp/STATE.md & .mcp/PLAN.md): Tüm mimari kararlar ve tamamlanan adımlar proje kökündeki .mcp/ klasöründe tutulur; sekme veya model değişse bile bağlam kaybolmaz.Dizin Güvenliği: MCP sunucusu yalnızca VS Code'da o an açık olan çalışma alanı (workspaceFolder) içindeki dosyalara erişebilir; üst dizinlere (../) erişim engellenmiştir.
<ElicitationsGroup message="Dokümantasyon veya proje dosyaları üzerinde başka bir düzenleme yapalım mı?">
  <Elicitation label="Git ile paylaşıma uygun .gitignore dosyası oluştur" query="Projedeki node_modules, .mcp/.tmp_diff ve geçici sistem dosyalarını hariç tutan temiz bir .gitignore dosyası hazırla."/>
  <Elicitation label="Yerel AI arayüzleri (Ollama / OpenWebUI) için domain ekleme bölümünü dokümana ekle" query="README.md dosyasına yerel Ollama WebUI veya özel AI alan adlarını eklentiye nasıl ekleyeceğimizi anlatan bir bölüm ekle."/>
</ElicitationsGroup>
