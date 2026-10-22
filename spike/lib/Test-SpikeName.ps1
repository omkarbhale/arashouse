# Checks names and folders against the spike guards without touching anything.
# Usage: Test-SpikeName.ps1 -Kind Database -Name OLM_Local      (prints ALLOWED or DENIED: <reason>; exit 0 or 2)
#        Test-SpikeName.ps1 -CaseFile cases.txt                  (one "Kind|Name" per line; Kind may be Folder, ReadFolder)
param(
    [string]$Kind,
    [string]$Name,
    [string]$CaseFile
)
. (Join-Path $PSScriptRoot 'SpikeCommon.ps1')

function Test-One([string]$k, [string]$n) {
    try {
        switch ($k) {
            'Folder' { [void](Assert-SpikePath -Path $n -Mode Write) }
            'ReadFolder' { [void](Assert-SpikePath -Path $n -Mode Read) }
            default { Assert-SpikeName -Kind $k -Name $n }
        }
        return $null
    } catch {
        return $_.Exception.Message
    }
}

$denied = 0
$cases = @()
if ($CaseFile) {
    foreach ($line in [IO.File]::ReadAllLines($CaseFile)) {
        if (-not $line.Trim()) { continue }
        $i = $line.IndexOf('|')
        $cases += , @($line.Substring(0, $i), $line.Substring($i + 1))
    }
} else {
    $cases += , @($Kind, $Name)
}
foreach ($c in $cases) {
    $reason = Test-One $c[0] $c[1]
    if ($reason) { $denied++; Write-Output ("DENIED|{0}|{1}|{2}" -f $c[0], $c[1], $reason) }
    else { Write-Output ("ALLOWED|{0}|{1}" -f $c[0], $c[1]) }
}
if (-not $CaseFile -and $denied -gt 0) { exit 2 }
exit 0
