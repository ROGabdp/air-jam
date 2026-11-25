# Air Jam 啟動腳本：開一個本機伺服器，再用瀏覽器打開遊戲。
param([int]$Port = 8020, [switch]$NoBrowser)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$Host.UI.RawUI.WindowTitle = 'Air Jam'

# 找可以用的 Python（先試 py，再試 python；跳過 Microsoft Store 的空殼）
$py = $null
foreach ($cmd in @('py', 'python')) {
  try { & $cmd --version *> $null; if ($LASTEXITCODE -eq 0) { $py = $cmd; break } } catch {}
}
if (-not $py) {
  Write-Host '找不到 Python。請先到 https://www.python.org/downloads/ 安裝 Python，再重新執行。' -ForegroundColor Yellow
  Read-Host '按 Enter 關閉'
  exit 1
}

# 連接埠被佔用的話，自動換下一個
$listener = $null
while ($true) {
  try { $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port); $listener.Start(); $listener.Stop(); break }
  catch { $Port++ }
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host '  Air Jam 空中即興' -ForegroundColor Cyan
Write-Host '  ----------------'
Write-Host "  遊戲網址：$url"
Write-Host "  沒有鏡頭的話，改開：${url}?mouse=1"
Write-Host '  建議用 Chrome 或 Edge。玩完直接關掉這個視窗就好。'
Write-Host ''

if (-not $NoBrowser) {
  Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 2; Start-Process $u } -ArgumentList $url | Out-Null
}

# 有些 Windows 會把 .js 標成 text/plain，瀏覽器就不肯載入 ES module，所以這裡強制指定正確的類型
$server = "import http.server as h, sys; H = h.SimpleHTTPRequestHandler; H.extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}); h.test(HandlerClass=H, port=int(sys.argv[1]), bind='127.0.0.1')"
& $py -c $server $Port
if ($LASTEXITCODE -ne 0) {
  Write-Host '伺服器沒有啟動成功。' -ForegroundColor Yellow
  Read-Host '按 Enter 關閉'
}
