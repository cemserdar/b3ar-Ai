# Web-MCP Suite — Kurulum

## 1. Paketi kurun

| Sistem | Komut |
|---|---|
| Linux / macOS | Terminalde bu klasörde: `./install.sh` |
| Windows | `install.cmd` dosyasına çift tıklayın |

Betik VS Code eklentisini kurar ve VS Code'u açar. Linux'ta arka plan modu için gereken
Chromium + Xvfb eksikse kurmayı önerir (onayınızla, `sudo` ile).

Elle kurulum: `code --install-extension web-mcp-<sürüm>.vsix`

## 2. Tarayıcı eklentilerini kurun

VS Code açılınca sağ altta **"Web-MCP kuruldu!"** bildirimi çıkar → **Kurulumu Başlat**.
(Sonradan: Komut Paleti → `Web-MCP: Kurulum Sihirbazı`.)

Sihirbaz yüklü tarayıcıları bulur:

- **Chrome / Chromium / Brave / Edge:** Eklentiler sayfası açılır, klasör yolu panoya kopyalanır.
  *Geliştirici modu* → *Paketlenmemiş öğe yükle* → `Ctrl+L` ile yolu yapıştırın.
  (Chrome, mağaza dışı eklentilerin sessizce kurulmasına izin vermez; bu tek seferlik adım elle yapılır.)
- **Firefox / Zen / LibreWolf:** Paket imzalıysa tek tıkla **Ekle**. İmzasızsa geçici kurulum
  (Firefox kapanınca silinir) — kalıcı kurulum için paketi imzalı oluşturun.

## 3. Eşleştirme (otomatik)

Tarayıcı eklentisi kurulduğu anda VS Code'da **"Bir tarayıcı eklentisi bağlanmak istiyor"** penceresi çıkar
→ **İzin Ver**. Token otomatik aktarılır; kopyala-yapıştır gerekmez.
(Gerekirse eklenti menüsünde **🔗 VS Code ile Eşleştir**.)

## 4. (İsteğe bağlı) Arka plan modu

Durum çubuğunda **Web-MCP** → *Arka plan tarayıcısını görünür aç* → AI sitelerine bir kez giriş yapın
→ menüden *Gizli başlat*. Doğrulama (CAPTCHA) çıkarsa tarayıcı otomatik görünür olur.
