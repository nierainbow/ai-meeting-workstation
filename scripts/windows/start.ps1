# Windows 版启动器，由根目录「启动会议纪要-Windows.bat」调用。行为与 macOS 的「启动会议纪要.command」一致。
# 设置 MEETING_LAUNCHER_SMOKE=1 时只做启动自检（供 CI 使用）：确认前后端可访问后自动退出，不打开浏览器。
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $AppDir
$Smoke = $env:MEETING_LAUNCHER_SMOKE -eq "1"

function Wait-BeforeClose {
  if (-not $Smoke -and -not $env:CI) { Read-Host "按回车关闭窗口" | Out-Null }
}

function Stop-Launcher([string]$Message) {
  Write-Host ""
  Write-Host $Message -ForegroundColor Red
  Wait-BeforeClose
  exit 1
}

function Get-ListeningProcessId([int]$Port) {
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($connection) { return $connection.OwningProcess }
  return $null
}

function Stop-ServiceTree($Process) {
  if ($Process -and -not $Process.HasExited) {
    & taskkill /PID $Process.Id /T /F *> $null
  }
}

Write-Host "正在启动 AI 会议工作台..."
Write-Host "工作目录：$AppDir"
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  Stop-Launcher "在 PATH 中找不到 npm。请先确认 Node.js 已安装，或先双击「安装-Windows.bat」。"
}
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir ".local-data") | Out-Null

foreach ($port in @(8787, 5173)) {
  $owner = Get-ListeningProcessId $port
  if ($owner) {
    Stop-Launcher "端口 $port 已被占用，当前进程：$($owner)。请先关闭占用该端口的本地服务，再重新双击启动。"
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $AppDir "node_modules"))) {
  Write-Host "首次启动需要安装本地依赖，正在执行 npm install..."
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { Stop-Launcher "依赖安装失败，请检查网络或 Node.js 环境。" }
}

$LogDir = Join-Path $AppDir ".local-data"
$ServerLog = Join-Path $LogDir "launcher-server.log"
$ServerErrLog = Join-Path $LogDir "launcher-server.err.log"
$ClientLog = Join-Path $LogDir "launcher-client.log"
$ClientErrLog = Join-Path $LogDir "launcher-client.err.log"

Write-Host "正在启动后端服务..."
$Server = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev:server" -WorkingDirectory $AppDir `
  -RedirectStandardOutput $ServerLog -RedirectStandardError $ServerErrLog -NoNewWindow -PassThru
Write-Host "正在启动前端面板..."
$Client = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev:client" -WorkingDirectory $AppDir `
  -RedirectStandardOutput $ClientLog -RedirectStandardError $ClientErrLog -NoNewWindow -PassThru

function Wait-ForPort([int]$Port, [string]$Label, [string]$Log, [string]$ErrLog) {
  # Windows 首次启动（杀毒扫描、冷缓存）明显慢于 macOS，给 90 秒。
  for ($i = 0; $i -lt 180; $i++) {
    if (Get-ListeningProcessId $Port) {
      Write-Host "$Label 已启动：http://127.0.0.1:$Port"
      return
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host ""
  Write-Host "$Label 启动失败，端口 $Port 没有监听。" -ForegroundColor Red
  Write-Host "最近日志："
  foreach ($file in @($Log, $ErrLog)) {
    if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file -Tail 30 -Encoding UTF8 }
  }
  Stop-ServiceTree $Server
  Stop-ServiceTree $Client
  Wait-BeforeClose
  exit 1
}

Wait-ForPort 8787 "后端服务" $ServerLog $ServerErrLog
Wait-ForPort 5173 "前端面板" $ClientLog $ClientErrLog

if ($Smoke) {
  $ok = $true
  foreach ($url in @("http://127.0.0.1:8787/api/health", "http://127.0.0.1:5173/")) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30
      Write-Host "自检通过：$url -> $($response.StatusCode)"
    } catch {
      Write-Host "自检失败：$url -> $($_.Exception.Message)" -ForegroundColor Red
      $ok = $false
    }
  }
  Stop-ServiceTree $Server
  Stop-ServiceTree $Client
  if ($ok) { exit 0 } else { exit 1 }
}

Write-Host "浏览器会自动打开会议纪要面板。"
Start-Process "http://127.0.0.1:5173"
Write-Host ""
Write-Host "服务运行中。按回车或直接关闭此窗口，都会停止本地服务。"
Write-Host "日志："
Write-Host "  后端：$ServerLog"
Write-Host "  前端：$ClientLog"
Read-Host | Out-Null
Stop-ServiceTree $Server
Stop-ServiceTree $Client
exit 0
