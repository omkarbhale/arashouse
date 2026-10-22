# One-time, elevated: create C:\aras_installations\{spike,spike\out,staging} and let the worker user modify spike\ and staging\ only.
# Dry run by default; -Apply makes the changes. Windows PowerShell 5.1.
param(
    [switch]$Apply,
    # The account the worker runs as (the same account as the captain's, non-elevated).
    [string]$WorkerUser = ($env:USERDOMAIN + '\' + $env:USERNAME)
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

try {
    if (($PSBoundParameters.ContainsKey('WorkerUser') -or $Apply) -and $WorkerUser -notmatch '^[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+$') { throw "PARAM: -WorkerUser '$WorkerUser' is not DOMAIN\user." }
    $spike = Assert-SpikePath -Path $script:SpikeRoot -Mode Write -AllowRoot
    $out = Assert-SpikePath -Path $script:SpikeOutDir -Mode Write
    $staging = Assert-SpikePath -Path $script:SpikeStagingDir -Mode Read -AllowRoot
    Start-Spike -Name '01-init-folders' -Apply $Apply.IsPresent -NeedsElevation

    foreach ($dir in @($script:SpikeInstallRoot, $spike, $out, $staging)) {
        Invoke-SpikeStep "create folder $dir if it is missing" {
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        }
    }
    foreach ($dir in @($spike, $staging)) {
        Invoke-SpikeStep "grant $WorkerUser modify on $dir (icacls, inherited by what is created inside)" {
            & icacls.exe $dir /grant ("{0}:(OI)(CI)M" -f $WorkerUser) | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "ICACLS: granting modify on '$dir' failed ($LASTEXITCODE)." }
        }
    }
    Invoke-SpikeStep "grant IIS_IUSRS modify on $spike (the spike application pools run as members of this group)" {
        & icacls.exe $spike /grant 'IIS_IUSRS:(OI)(CI)M' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "ICACLS: granting IIS_IUSRS on '$spike' failed ($LASTEXITCODE)." }
    }
    Add-SpikeFact -Key 'workerUserGranted' -Value ($WorkerUser -replace '^.*\\', '<user>')
    Add-SpikeFact -Key 'folders' -Value @($spike, $out, $staging)
    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
