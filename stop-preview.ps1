$ErrorActionPreference = 'Stop'
$piccPidFile = Join-Path $PSScriptRoot 'instance\preview.pid'
if (-not (Test-Path -LiteralPath $piccPidFile)) { Write-Output 'No launcher-managed preview is running.'; exit 0 }
$piccPreviewPid = [int](Get-Content -LiteralPath $piccPidFile)
$piccOwned = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $piccPreviewPid)
if ($piccOwned -and $piccOwned.CommandLine -match [regex]::Escape((Join-Path $PSScriptRoot 'app.py')) -and $piccOwned.CommandLine -match '--demo.*--port\s+8765') {
    Stop-Process -Id $piccPreviewPid
    Write-Output 'PICC preview stopped. Records were kept.'
} elseif ($piccOwned) { throw 'The saved process does not match this preview; it was not stopped.' }
else { Write-Output 'The managed preview has already exited.' }
Remove-Item -LiteralPath $piccPidFile
