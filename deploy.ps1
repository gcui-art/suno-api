#!/usr/bin/env pwsh
<#
.SYNOPSIS
  suno-api 一键 重新编译 + 后台启动 + 日志查看

.USAGE
  .\deploy.ps1          # 重新编译并启动（默认）
  .\deploy.ps1 -Build   # 仅重新编译
  .\deploy.ps1 -Start   # 仅启动（不重新编译）
  .\deploy.ps1 -Logs    # 实时查看日志
  .\deploy.ps1 -Stop    # 停止服务
  .\deploy.ps1 -Status  # 查看运行状态
#>

param(
    [switch]$Build,
    [switch]$Start,
    [switch]$Logs,
    [switch]$Stop,
    [switch]$Status
)

$ROOT     = $PSScriptRoot
$LOG_DIR  = Join-Path $ROOT "logs"
$LOG_FILE = Join-Path $LOG_DIR "app.log"
$PID_FILE = Join-Path $ROOT ".suno-api.pid"

# 如果不加任何参数 => 默认执行 编译 + 启动
if (-not ($Build -or $Start -or $Logs -or $Stop -or $Status)) {
    $Build = $true
    $Start = $true
}

# ────────────────────────────────────────────────────
function Write-Step([string]$msg) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] $msg" -ForegroundColor Cyan
}

function Stop-Service {
    if (Test-Path $PID_FILE) {
        $pid = Get-Content $PID_FILE -Raw | ForEach-Object { $_.Trim() }
        if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
            Write-Step "停止旧进程 (PID: $pid)..."
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        Remove-Item $PID_FILE -Force
    }
    # 防止端口残留
    $portProc = (netstat -ano | Select-String ":8005 .*LISTENING") -replace '.*\s(\d+)$','$1' | Select-Object -First 1
    if ($portProc -and ($portProc -match '^\d+$')) {
        Stop-Process -Id ([int]$portProc) -Force -ErrorAction SilentlyContinue
    }
}

# ────────────────────────────────────────────────────
if ($Stop) {
    Write-Step "停止 suno-api..."
    Stop-Service
    Write-Host "已停止。" -ForegroundColor Green
    exit 0
}

if ($Status) {
    if (Test-Path $PID_FILE) {
        $pid = Get-Content $PID_FILE -Raw | ForEach-Object { $_.Trim() }
        if (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
            Write-Host "运行中 (PID: $pid)" -ForegroundColor Green
        } else {
            Write-Host "进程已退出（PID 文件残留: $pid）" -ForegroundColor Yellow
        }
    } else {
        Write-Host "未运行" -ForegroundColor Red
    }
    exit 0
}

if ($Logs) {
    if (-not (Test-Path $LOG_FILE)) {
        Write-Host "日志文件不存在: $LOG_FILE" -ForegroundColor Red
        exit 1
    }
    Write-Host "实时跟踪日志（Ctrl+C 退出）：$LOG_FILE`n" -ForegroundColor Cyan
    Get-Content $LOG_FILE -Wait -Tail 50
    exit 0
}

# ────────────────────────────────────────────────────
Set-Location $ROOT

if ($Build) {
    Write-Step "安装依赖..."
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Host "npm install 失败！" -ForegroundColor Red; exit 1 }

    Write-Step "编译项目..."
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host "编译失败！" -ForegroundColor Red; exit 1 }
    Write-Host "编译成功 ✓" -ForegroundColor Green
}

if ($Start) {
    Write-Step "停止旧实例..."
    Stop-Service

    New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

    Write-Step "在后台启动 suno-api（端口 8005）..."
    $proc = Start-Process -FilePath "npm" `
        -ArgumentList "run", "start" `
        -WorkingDirectory $ROOT `
        -RedirectStandardOutput $LOG_FILE `
        -RedirectStandardError  (Join-Path $LOG_DIR "app-err.log") `
        -NoNewWindow `
        -PassThru

    $proc.Id | Out-File $PID_FILE -NoNewline
    Write-Host "启动成功 ✓  PID: $($proc.Id)" -ForegroundColor Green
    Write-Host ""
    Write-Host "  查看日志：  .\deploy.ps1 -Logs" -ForegroundColor DarkCyan
    Write-Host "  停止服务：  .\deploy.ps1 -Stop" -ForegroundColor DarkCyan
    Write-Host "  访问地址：  http://localhost:8005" -ForegroundColor DarkCyan
    Write-Host "  API 文档：  http://localhost:8005/docs" -ForegroundColor DarkCyan
    Write-Host ""

    # 等几秒后打印启动日志前几行，确认是否正常
    Start-Sleep -Seconds 3
    if (Test-Path $LOG_FILE) {
        Write-Host "──── 最新日志 ────" -ForegroundColor DarkGray
        Get-Content $LOG_FILE -Tail 10
        Write-Host "──────────────────" -ForegroundColor DarkGray
    }
}
