<#
.SYNOPSIS
    启动 Bytro Community Edition 并把日志全部重定向到桌面，用于排查安装包问题。

.DESCRIPTION
    安装包不能直接打开 DevTools，所以只能靠落盘日志。本脚本同时捕获三份：

      1) 应用进程的 stdout/stderr （Rust 后端的 println!/eprintln!，
         以及 PowerShell 启动 WebView2 透出的部分日志）
      2) WebView2 的内部日志：通过 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
         注入 --enable-logging 开启，作为前端 console.* 的兜底来源
      3) Windows 应用事件日志中与该进程相关的崩溃/错误（脚本结束时一次性导出）

.PARAMETER ExePath
    Bytro Community Edition 可执行文件的完整路径，例如：
        "C:\Program Files\Bytro Community Edition\bytro-community.exe"
    优先级最高。同时给 -ExePath 与 -InstallDir 时以 -ExePath 为准。

.PARAMETER InstallDir
    Bytro Community Edition 安装目录，例如：
        "C:\Program Files\Bytro Community Edition"
        "$env:LOCALAPPDATA\Bytro Community Edition"
    目录内需要包含 bytro-community.exe。

.PARAMETER Filter
    实时显示命中关键字的行（原始日志仍完整落盘）。例如：
        -Filter "split-drag"

    既没传 -ExePath 也没传 -InstallDir 时会弹出文件选择器让用户挑 .exe。

.EXAMPLE
    # 交互式（双击/右键运行，弹文件选择器选 bytro-community.exe）
    powershell -ExecutionPolicy Bypass -File scripts\capture-windows-logs.ps1

.EXAMPLE
    # 直接指定 exe
    powershell -ExecutionPolicy Bypass -File scripts\capture-windows-logs.ps1 `
        -ExePath "C:\Program Files\Bytro Community Edition\bytro-community.exe"

.EXAMPLE
    # 指定安装目录 + 实时过滤
    powershell -ExecutionPolicy Bypass -File scripts\capture-windows-logs.ps1 `
        -InstallDir "C:\Program Files\Bytro Community Edition" -Filter "split-drag"

.NOTES
    操作步骤：
      1) PowerShell 运行此脚本，它会启动 Bytro Community Edition 并开始抓取
      2) 在应用窗口里复现问题
      3) 复现完成后回到本终端按 Ctrl+C 结束抓取
      4) 桌面会得到 3 份 log 文件，打包发给开发者即可
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false, Position = 0)]
    [string]$InstallDir,

    [Parameter(Mandatory = $false)]
    [string]$ExePath,

    [Parameter(Mandatory = $false)]
    [string]$Filter = ""
)

$ErrorActionPreference = "Stop"

# 强制控制台 UTF-8，避免中文输出乱码
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [System.Text.UTF8Encoding]::new()
} catch {}

# ------------------------------------------------------------
# 平台检查
# ------------------------------------------------------------
if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
    Write-Error "[error] 此脚本仅支持 Windows"
    exit 1
}

# ------------------------------------------------------------
# 定位可执行文件
#   优先级：-ExePath > -InstallDir > 弹出文件选择器
# ------------------------------------------------------------
function Select-ExeWithDialog {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null

    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = "选择 Bytro Community Edition 可执行文件"
    $dlg.Filter = "Bytro Community Edition|bytro-community.exe;Bytro Community Edition.exe|Executables (*.exe)|*.exe|All files (*.*)|*.*"
    $dlg.FilterIndex = 1
    $dlg.CheckFileExists = $true
    $dlg.Multiselect = $false

    foreach ($guess in @(
        "${env:ProgramFiles}\Bytro Community Edition",
        "${env:ProgramFiles(x86)}\Bytro Community Edition",
        "${env:LOCALAPPDATA}\Bytro Community Edition",
        "${env:LOCALAPPDATA}\Programs\Bytro Community Edition"
    )) {
        if ($guess -and (Test-Path -LiteralPath $guess -PathType Container)) {
            $dlg.InitialDirectory = $guess
            break
        }
    }

    $result = $dlg.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
        return $null
    }
    return $dlg.FileName
}

$Bin = $null

if ($ExePath) {
    if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
        Write-Error "[error] -ExePath 指向的文件不存在: $ExePath"
        exit 1
    }
    $Bin = (Resolve-Path -LiteralPath $ExePath).Path
} elseif ($InstallDir) {
    if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) {
        Write-Error "[error] 安装目录不存在: $InstallDir"
        exit 1
    }
    $InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path

    # Tauri 通常使用 Cargo.toml::package.name；部分打包器可能使用 productName。
    foreach ($name in @("bytro-community.exe", "Bytro Community Edition.exe")) {
        $path = Join-Path $InstallDir $name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $Bin = $path
            break
        }
    }

    if (-not $Bin) {
        Write-Error @"
[error] 在安装目录中找不到主程序 (尝试过: bytro-community.exe, Bytro Community Edition.exe)
        InstallDir: $InstallDir
"@
        exit 1
    }
} else {
    Write-Host "未指定 -ExePath / -InstallDir，将弹出文件选择器..."
    $Bin = Select-ExeWithDialog
    if (-not $Bin) {
        Write-Host "[info] 已取消选择，退出。"
        exit 0
    }
}

$BinName = [System.IO.Path]::GetFileNameWithoutExtension($Bin)

# ------------------------------------------------------------
# 准备日志文件
# ------------------------------------------------------------
$Desktop = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrEmpty($Desktop)) {
    $Desktop = Join-Path $env:USERPROFILE "Desktop"
}
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$AppLog = Join-Path $Desktop "bytro-community-app-$Timestamp.log"
$WebViewLogDir = Join-Path $Desktop "bytro-community-webview-$Timestamp"
$WebViewLog = Join-Path $WebViewLogDir "webview2.log"
$EventLog = Join-Path $Desktop "bytro-community-eventlog-$Timestamp.log"

New-Item -ItemType Directory -Path $WebViewLogDir -Force | Out-Null

# ------------------------------------------------------------
# 杀掉已在运行的实例，避免日志混淆
# ------------------------------------------------------------
$running = @(Get-Process -Name $BinName -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host "[info] 检测到 $BinName 已在运行，先退出旧实例..."
    $running | ForEach-Object {
        try { $_.CloseMainWindow() | Out-Null } catch {}
    }
    Start-Sleep -Seconds 1
    $stillRunning = @(Get-Process -Name $BinName -ErrorAction SilentlyContinue)
    if ($stillRunning.Count -gt 0) {
        $stillRunning | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
}

# ------------------------------------------------------------
# 横幅
# ------------------------------------------------------------
$banner = @"
============================================================
  Bytro Community Edition 日志捕获 (Windows)
============================================================
  应用路径:        $Bin
  应用日志:        $AppLog
  WebView2 日志:   $WebViewLog
  事件日志:        $EventLog
"@
Write-Host $banner
if ($Filter) {
    Write-Host "  实时过滤:        $Filter"
}
Write-Host @"

操作步骤:
  1) 应用启动后，在窗口内复现问题
  2) 复现完成后回到此终端按 Ctrl+C 结束抓取
  3) 桌面会得到 3 份日志，打包发给开发者
============================================================
"@

# ------------------------------------------------------------
# 注入 WebView2 启动参数，把 chromium 内部日志写到磁盘
# 详见 https://learn.microsoft.com/microsoft-edge/webview2/concepts/enable-chromium-logging
#   --enable-logging       打开日志（默认会写到 user-data-dir 中）
#   --log-file=<path>      指定日志文件
#   --v=1                  verbosity: 0 INFO / 1 verbose / 更高更啰嗦
# ------------------------------------------------------------
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--enable-logging --log-file=`"$WebViewLog`" --v=1"

# Rust env_logger 兜底：让后端日志尽量啰嗦一点
if (-not $env:RUST_LOG) { $env:RUST_LOG = "info" }
$env:RUST_BACKTRACE = "1"

# ------------------------------------------------------------
# 记录启动时刻，用于 Ctrl+C 后从事件日志按时间过滤
# ------------------------------------------------------------
$startTime = Get-Date

# ------------------------------------------------------------
# 退出清理：导出事件日志、提示文件位置
# ------------------------------------------------------------
function Invoke-Cleanup {
    Write-Host ""
    Write-Host "停止抓取..."

    # 应用还在跑就关掉，避免后台残留
    $alive = @(Get-Process -Name $BinName -ErrorAction SilentlyContinue)
    if ($alive.Count -gt 0) {
        $alive | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
        Start-Sleep -Milliseconds 500
        $alive = @(Get-Process -Name $BinName -ErrorAction SilentlyContinue)
        if ($alive.Count -gt 0) {
            $alive | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    }

    # 导出 Windows 应用事件日志中与该进程相关的崩溃/错误
    try {
        $events = Get-WinEvent -FilterHashtable @{
            LogName   = 'Application'
            StartTime = $startTime
            Level     = 1, 2, 3   # Critical / Error / Warning
        } -ErrorAction SilentlyContinue | Where-Object {
            $_.ProviderName -match 'Application Error|Windows Error Reporting|\.NET Runtime|WebView2' `
                -or $_.Message -match "$BinName|Bytro Community Edition|WebView2"
        }

        if ($events -and $events.Count -gt 0) {
            $events |
                Sort-Object TimeCreated |
                Format-List TimeCreated, ProviderName, Id, LevelDisplayName, Message |
                Out-File -FilePath $EventLog -Encoding UTF8
        } else {
            "(no matching events between $startTime and $(Get-Date))" |
                Out-File -FilePath $EventLog -Encoding UTF8
        }
    } catch {
        "Failed to read event log: $_" | Out-File -FilePath $EventLog -Encoding UTF8
    }

    Write-Host ""
    Write-Host "[OK] 日志已保存到桌面:"
    Write-Host "    $AppLog"
    Write-Host "    $WebViewLog"
    Write-Host "    $EventLog"
    Write-Host ""

    if ($Filter) {
        Write-Host "查看过滤后的内容:"
        Write-Host "    Select-String -Pattern '$Filter' -Path '$AppLog','$WebViewLog'"
    } else {
        Write-Host "按关键字检索（可改关键字）:"
        Write-Host "    Select-String -Pattern 'split-drag' -Path '$AppLog','$WebViewLog'"
    }
}

# ------------------------------------------------------------
# 前台启动二进制，捕获 stdout+stderr 到日志文件
# 直接调用 .exe（不用 Start-Process），这样 Rust 后端的 println!/eprintln!
# 会落到管道里，被 Tee-Object 同时写进终端和日志。
# 按 Ctrl+C 时 PowerShell 会终止子进程，并跳到 finally 块执行清理。
# ------------------------------------------------------------
Write-Host "[启动] $Bin"
Write-Host "(应用窗口出现后即可操作；按 Ctrl+C 或关闭窗口结束抓取)"
Write-Host ""

# PS 5.1 在 EAP=Stop 时会把原生命令的 stderr (经 2>&1) 当成
# terminating error，导致应用刚输出第一行日志就被 pipeline 中断。
# 跑应用期间临时切到 Continue，让 stderr 当作普通输出流处理。
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

try {
    if ($Filter) {
        # 完整内容写到 AppLog；终端只显示过滤后的行
        & $Bin 2>&1 |
            Tee-Object -FilePath $AppLog |
            Select-String -Pattern $Filter -SimpleMatch:$false
    } else {
        & $Bin 2>&1 | Tee-Object -FilePath $AppLog
    }
} finally {
    $ErrorActionPreference = $savedEAP
    Invoke-Cleanup
}
