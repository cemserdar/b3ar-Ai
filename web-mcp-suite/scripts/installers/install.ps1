# Web-MCP Suite kurulum betiği (Windows)
#  1) VS Code eklentisini (.vsix) kurar — tarayıcı eklentileri bu paketin içindedir.
#  2) VS Code'u açar; "Kurulumu Başlat" bildirimi tarayıcı eklentilerini kurar.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vsix = Get-ChildItem -Path $dir -Filter 'web-mcp-*.vsix' | Select-Object -First 1
if (-not $vsix) { Write-Host 'web-mcp-*.vsix bulunamadı.' -ForegroundColor Red; exit 1 }

$cli = $null
foreach ($name in @('code', 'code-insiders', 'codium', 'cursor', 'windsurf')) {
  $cmd = Get-Command "$name.cmd" -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command $name -ErrorAction SilentlyContinue }
  if ($cmd) { $cli = $cmd.Source; break }
}
if (-not $cli) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"
  )
  $cli = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $cli) { Write-Host 'VS Code bulunamadı. Önce VS Code kurun.' -ForegroundColor Red; exit 1 }

Write-Host "▶ VS Code eklentisi kuruluyor ($cli)..." -ForegroundColor Cyan
& $cli --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { Write-Host 'Kurulum başarısız.' -ForegroundColor Red; exit 1 }
Write-Host '✔ VS Code eklentisi kuruldu.' -ForegroundColor Green

Write-Host "▶ VS Code açılıyor. Sağ alttaki 'Web-MCP kuruldu!' bildiriminde 'Kurulumu Başlat'a tıklayın." -ForegroundColor Cyan
Start-Process -FilePath $cli -WindowStyle Hidden
Write-Host '✔ Kurulum tamamlandı.' -ForegroundColor Green
