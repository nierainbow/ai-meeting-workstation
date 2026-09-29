# Windows 版安装器，由根目录「安装-Windows.bat」调用。步骤与 macOS 的「安装.command」一致。
# 不会自动安装 Node.js / Python，不会读取或覆盖现有 .env；安装 ffmpeg 前必须用户输入 y。
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $AppDir
$Unattended = [bool]$env:CI

function Wait-BeforeClose {
  if (-not $Unattended) { Read-Host "按回车关闭窗口" | Out-Null }
}

function Stop-Install([string]$Message) {
  Write-Host ""
  Write-Host "安装未完成：$Message" -ForegroundColor Red
  Write-Host "修好后重新双击「安装-Windows.bat」即可继续；已完成的步骤会跳过。"
  Wait-BeforeClose
  exit 1
}

function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Find-Python {
  # 优先用 Python 官方安装器自带的 py 启动器，其次是 PATH 里的 python。
  # 版本探测只用单引号，避免 Windows PowerShell 5.1 传参时吞掉双引号。
  $probe = "import sys, venv; v=sys.version_info; print(str(v.major)+'.'+str(v.minor)+'|'+sys.executable)"
  $candidates = @()
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $candidates += @(@("py", "-3.13"), @("py", "-3.12"), @("py", "-3.11"))
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    $candidates += , @("python")
  }
  foreach ($candidate in $candidates) {
    $exe = $candidate[0]
    $prefix = @($candidate | Select-Object -Skip 1)
    $output = & $exe @prefix -c $probe 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $output) { continue }
    $parts = "$output".Trim().Split("|")
    if ($parts[0] -in @("3.11", "3.12", "3.13")) { return $parts[1] }
  }
  return $null
}

Write-Host "AI 会议工作台安装器（Windows）"
Write-Host "安装位置：$AppDir"
Write-Host "不会自动安装 Node.js 或 Python，也不会读取或覆盖现有 .env。"
Write-Host ""

$InstallMode = $env:MEETING_INSTALL_MODE
if (-not $InstallMode) {
  Write-Host "请选择用途："
  Write-Host "  1. 本地转写 + 工作台（约需数 GB 模型下载；Windows 下用 CPU 转写，速度明显慢于 Apple Silicon Mac）"
  Write-Host "  2. 仅云端转写 + 工作台（不用下载本地模型）"
  $choice = Read-Host "输入 1 或 2，回车确认 [1]"
  $InstallMode = if ($choice -eq "2") { "cloud" } else { "local" }
}
if ($InstallMode -notin @("local", "cloud")) { Stop-Install "安装模式只能是 local 或 cloud。" }

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NpmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $NodeCmd -or -not $NpmCmd) {
  Stop-Install "找不到 Node.js/npm。请从 https://nodejs.org/ 安装 Node.js 22 或 24（LTS 长期支持版），安装后重新双击本文件。"
}
$NodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 22) { Stop-Install "当前 Node.js 版本过低。请从 https://nodejs.org/ 安装 22 或 24（LTS 长期支持版）。" }
Write-Host "✓ Node.js $(& node --version)"
if ($NodeMajor -gt 24) {
  Write-Host "提示：当前 Node.js 比 24 更新。若下一步 npm ci 报 better-sqlite3 编译错误，请改装 Node.js 24 LTS 后重试。" -ForegroundColor Yellow
}

if ($InstallMode -eq "local") {
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Stop-Install "找不到 ffmpeg，也找不到 winget。请从 https://www.gyan.dev/ffmpeg/builds/ 下载 ffmpeg，并把其中的 bin 目录加入系统 PATH 后重试；或选择仅云端模式。"
    }
    Write-Host "本地转写需要 ffmpeg。可通过 Windows 自带的 winget 安装，这会修改本机全局环境。"
    $answer = Read-Host "是否现在执行 winget install Gyan.FFmpeg？输入 y 才安装 [N]"
    if ($answer -notin @("y", "Y")) { Stop-Install "你未同意安装 ffmpeg。可自行安装后重试，或选择仅云端模式。" }
    & winget install --id Gyan.FFmpeg -e
    if ($LASTEXITCODE -ne 0) { Stop-Install "ffmpeg 安装失败。请检查网络，或按 https://www.gyan.dev/ffmpeg/builds/ 手动安装。" }
    Update-SessionPath
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
      Stop-Install "ffmpeg 已安装，但当前窗口还识别不到。请关闭本窗口，重新双击「安装-Windows.bat」。"
    }
  }
  Write-Host "✓ ffmpeg 可用"

  $VenvPython = Join-Path $AppDir ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $VenvPython)) {
    if (Test-Path -LiteralPath (Join-Path $AppDir ".venv")) {
      Stop-Install ".venv 已存在但不可用。请先自行备份/处理这个目录，本安装器不会覆盖它。"
    }
    $SystemPython = Find-Python
    if (-not $SystemPython) {
      Stop-Install "找不到可用的 Python 3.11–3.13。请从 https://www.python.org/downloads/windows/ 安装 Python 3.13，安装时勾选「Add python.exe to PATH」，然后重试。"
    }
    Write-Host "✓ Python：$SystemPython"
    Write-Host "正在创建项目专用 Python 环境…"
    & $SystemPython -m venv .venv
    if ($LASTEXITCODE -ne 0) { Stop-Install "创建 Python 虚拟环境失败，请检查磁盘空间和 Python 安装是否完整。" }
  }
  & $VenvPython --version *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Install ".venv 内的 Python 已失效，请先自行处理该目录后重试。" }

  # 完整依赖锁只在 macOS arm64 实测过；Windows 使用 requirements.txt 中固定的直接依赖。
  $RequirementsFile = "requirements.txt"
  $RequirementsHash = Get-FileSha256 $RequirementsFile
  $RequirementsMarker = Join-Path $AppDir ".venv\.requirements-sha256"
  $savedHash = if (Test-Path -LiteralPath $RequirementsMarker) { (Get-Content -LiteralPath $RequirementsMarker -Raw).Trim() } else { "" }
  & $VenvPython -c "import funasr, modelscope, torch, torchaudio" *> $null
  $importsOk = $LASTEXITCODE -eq 0
  if ($savedHash -ne $RequirementsHash -or -not $importsOk) {
    Write-Host "正在安装 Python 依赖；首次运行可能需要较长时间…"
    & $VenvPython -m pip install -r $RequirementsFile
    if ($LASTEXITCODE -ne 0) { Stop-Install "Python 依赖安装失败。请检查网络、磁盘空间和 Python 版本。" }
    & $VenvPython -m pip check
    if ($LASTEXITCODE -ne 0) { Stop-Install "Python 依赖版本冲突。请保留报错信息，勿继续下载模型。" }
    Set-Content -LiteralPath $RequirementsMarker -Value $RequirementsHash -NoNewline -Encoding ascii
  } else {
    Write-Host "✓ Python 依赖已安装，跳过"
  }

  Write-Host "正在检查 5 个本地模型；缺少的模型会从 ModelScope 下载…"
  & $VenvPython scripts\download_funasr_models.py --app-dir $AppDir
  if ($LASTEXITCODE -ne 0) { Stop-Install "模型下载失败。请检查 ModelScope 网络与磁盘空间，稍后重新运行可续装。" }
}

$LockHash = Get-FileSha256 "package-lock.json"
$LockMarker = Join-Path $AppDir "node_modules\.meeting-package-lock-sha256"
$nodeModulesOk = $false
if ((Test-Path -LiteralPath $LockMarker) -and ((Get-Content -LiteralPath $LockMarker -Raw).Trim() -eq $LockHash)) {
  & npm.cmd ls --depth=0 --silent *> $null
  $nodeModulesOk = $LASTEXITCODE -eq 0
}
if ($nodeModulesOk) {
  Write-Host "✓ Node 依赖已安装，跳过"
} else {
  Write-Host "正在安装 Node 依赖…"
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { Stop-Install "npm ci 失败。请检查网络和 Node.js 版本（推荐 22 或 24 LTS）。" }
  Set-Content -LiteralPath $LockMarker -Value $LockHash -NoNewline -Encoding ascii
}

Write-Host ""
Write-Host "安装完成。双击「启动会议纪要-Windows.bat」打开工作台。" -ForegroundColor Green
if ($InstallMode -eq "local") {
  Write-Host "在页面选择「本地 FunASR」可不填任何云端 Key 转写录音。"
} else {
  Write-Host "云端路线请在页面设置中填自己的火山 ASR Key；要用 AI 参谋还需填自己的 DeepSeek Key。"
}
Wait-BeforeClose
exit 0
