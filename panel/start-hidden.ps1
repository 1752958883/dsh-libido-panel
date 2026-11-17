$ErrorActionPreference = 'Stop'

$old = (Get-NetTCPConnection -LocalPort 41888 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($old) {
  Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 900
  "stopped old pid $old"
} else {
  "no listener on 41888"
}

$node = (Get-Command node.exe -CommandType Application).Source
$script = Join-Path $PSScriptRoot 'server.mjs'

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = '"' + $script + '"'
$psi.WorkingDirectory = $PSScriptRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
[void][System.Diagnostics.Process]::Start($psi)

Start-Sleep -Seconds 2
$now = Get-NetTCPConnection -LocalPort 41888 -State Listen -ErrorAction SilentlyContinue
if ($now) { "OK 41888 listening, new pid " + $now.OwningProcess } else { "FAIL 41888 not listening" }
