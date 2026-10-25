param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$piccUrl = 'http://127.0.0.1:8765'
$piccInstance = Join-Path $PSScriptRoot 'instance'
New-Item -ItemType Directory -Path $piccInstance -Force | Out-Null
$piccReady = $false
try {
    $piccProbe = Invoke-RestMethod -Uri ($piccUrl + '/api/config') -TimeoutSec 2
    if ($piccProbe.appName -eq 'picc-v2' -and $piccProbe.demo) { $piccReady = $true }
    else { throw 'Port 8765 is used by another service.' }
} catch {
    if ($_.Exception.Message -eq 'Port 8765 is used by another service.') { throw }
}
if (-not $piccReady) {
    $piccPythonCommand = (Get-Command python -ErrorAction Stop).Source
    $piccPython = (& $piccPythonCommand -c 'import sys; print(sys._base_executable)').Trim()
    if (-not (Test-Path -LiteralPath $piccPython -PathType Leaf)) { throw 'Python runtime was not found.' }
    $piccAppPath = Join-Path $PSScriptRoot 'app.py'
    $piccProcess = Start-Process -FilePath $piccPython -ArgumentList @('-u',('"'+$piccAppPath+'"'),'--demo','--port','8765') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $piccInstance 'preview.log') -RedirectStandardError (Join-Path $piccInstance 'preview-error.log')
    $piccProcess.Id | Set-Content -LiteralPath (Join-Path $piccInstance 'preview.pid')
    for ($piccTry=0; $piccTry -lt 25; $piccTry++) {
        Start-Sleep -Milliseconds 200
        try {
            $piccProbe = Invoke-RestMethod -Uri ($piccUrl + '/api/config') -TimeoutSec 1
            if ($piccProbe.appName -eq 'picc-v2' -and $piccProbe.demo) { $piccReady=$true; break }
        } catch {}
        if ($piccProcess.HasExited) { throw 'Preview did not start. See instance/preview-error.log.' }
    }
}
if (-not $piccReady) { throw 'Preview did not become ready.' }
if (-not $NoBrowser) { Start-Process -FilePath $piccUrl }
Write-Output 'PICC preview is ready. All preview records are synthetic.'
