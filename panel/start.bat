@echo off
setlocal
chcp 936 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
    echo 没有找到 Node.js。请确认 node.exe 已加入 PATH。
    pause
    exit /b 1
)

set "ALAN_PANEL_SCRIPT=%~dp0server.mjs"
powershell.exe -NoLogo -NoProfile -NonInteractive -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "try {" ^
    "    $settings = New-Object System.Diagnostics.ProcessStartInfo;" ^
    "    $settings.FileName = (Get-Command node.exe -CommandType Application -TotalCount 1).Source;" ^
    "    $settings.Arguments = [char]34 + $env:ALAN_PANEL_SCRIPT + [char]34;" ^
    "    $settings.UseShellExecute = $false; $settings.CreateNoWindow = $true;" ^
    "    $settings.RedirectStandardOutput = $true; $settings.RedirectStandardError = $true;" ^
    "    $settings.StandardErrorEncoding = [System.Text.Encoding]::UTF8;" ^
    "    $server = [System.Diagnostics.Process]::Start($settings);" ^
    "    $ready = $server.StandardOutput.ReadLineAsync();" ^
    "    if (-not $ready.Wait(10000)) { if (-not $server.HasExited) { $server.Kill() }; throw '面板启动超时。' };" ^
    "    if ($ready.Result -ne 'http://127.0.0.1:41888/') { throw $server.StandardError.ReadToEnd().Trim() };" ^
    "} catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
    pause
    exit /b 1
)

start "" "http://127.0.0.1:41888/"
