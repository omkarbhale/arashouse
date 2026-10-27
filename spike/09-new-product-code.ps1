# Makes a COPY of a flavor's InnovatorSetup.msi with a fresh ProductCode, ProductID, UpgradeCode and package code, so that it installs as a new
# product beside an existing install of the same release. Without this, msiexec sees the MSI's ProductCode on the host (the captain's own install)
# and runs in maintenance mode on THAT install, ignoring INSTALLDIR (ticket 05, 2026-10-26: nothing installed, the captain's product was reconfigured).
# Aras ships ChangeGUID.exe for this ("ChangeGUID new <display version> <msi>"). Its MSI edits are three UPDATE statements on the Property table
# (strings in the binary); the tool also writes to the machine's installer registry for the product code it reads, which would be the captain's
# product, so this script applies only the MSI edits, through the Windows Installer COM API. Not elevated; writes only under staging\<flavor>\instance\.
# The original media is only read. Dry run by default. Windows PowerShell 5.1.
param(
    [switch]$Apply,
    [ValidateSet('12sp9', '23', '35')][string]$Flavor = '12sp9',
    [string]$SourceMsi
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

function Invoke-MsiView($db, [string]$sql) {
    $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($sql))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
}

function Get-MsiValue($db, [string]$name) {
    $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$name'"))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
    $value = if ($rec) { [string]$rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, [object[]]@([int]1)) } else { $null }
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    return $value
}

try {
    $stageDir = Assert-SpikePath -Path (Join-Path $script:SpikeStagingDir $Flavor) -Mode Stage
    $outDir = Assert-SpikePath -Path (Join-Path $stageDir 'instance') -Mode Stage
    if (-not $SourceMsi) { $SourceMsi = Join-Path $stageDir 'cd\InnovatorSetup.msi' }
    $SourceMsi = Assert-SpikePath -Path $SourceMsi -Mode Read
    $target = Join-Path $outDir 'InnovatorSetup.msi'

    Start-Spike -Name "09-new-product-code-$Flavor" -Apply $Apply.IsPresent
    Add-SpikeFact 'flavor' $Flavor

    Invoke-SpikeStep "copy $SourceMsi to $target (the original is only read)" {
        if (-not (Test-Path -LiteralPath $SourceMsi)) { throw "MEDIA: $SourceMsi does not exist (run scripts/spike-sync.sh --media $Flavor from WSL)." }
        if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
        Copy-Item -LiteralPath $SourceMsi -Destination $target -Force
    }
    Invoke-SpikeStep 'set ProductCode, ProductID and UpgradeCode to new GUIDs and the summary-information package code (what ChangeGUID new does to the MSI)' {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @([string]$target, [int]1))
        # The summary information first: a view opened on the database before it makes the property set fail with a type mismatch.
        $summary = $db.GetType().InvokeMember('SummaryInformation', 'GetProperty', $null, $db, [object[]]@([int]1))
        $newPackage = '{' + [guid]::NewGuid().ToString().ToUpperInvariant() + '}'
        $summary.GetType().InvokeMember('Property', 'SetProperty', $null, $summary, [object[]]@([int]9, $newPackage))
        $summary.GetType().InvokeMember('Persist', 'InvokeMethod', $null, $summary, $null) | Out-Null
        $old = Get-MsiValue $db 'ProductCode'
        $newCode = '{' + [guid]::NewGuid().ToString().ToUpperInvariant() + '}'
        foreach ($name in @('ProductCode', 'ProductID')) {
            Invoke-MsiView $db "UPDATE ``Property`` SET ``Value`` = '$newCode' WHERE ``Property`` = '$name'"
        }
        $newUpgrade = '{' + [guid]::NewGuid().ToString().ToUpperInvariant() + '}'
        Invoke-MsiView $db "UPDATE ``Property`` SET ``Value`` = '$newUpgrade' WHERE ``Property`` = 'UpgradeCode'"
        $db.GetType().InvokeMember('Commit', 'InvokeMethod', $null, $db, $null) | Out-Null
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($summary)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db)
        $db = $null; $summary = $null; $installer = $null
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        Add-SpikeFact 'productCodeChanged' ($old -ne $newCode)
    }
    Invoke-SpikeStep 'confirm the copy opens, its ProductCode differs from the original and from every product installed on this host' {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $orig = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @([string]$SourceMsi, [int]0))
        $copy = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @([string]$target, [int]0))
        $origCode = Get-MsiValue $orig 'ProductCode'
        $copyCode = Get-MsiValue $copy 'ProductCode'
        $copyUpgrade = Get-MsiValue $copy 'UpgradeCode'
        $installed = @($installer.GetType().InvokeMember('Products', 'GetProperty', $null, $installer, $null) | ForEach-Object { [string]$_ })
        Add-SpikeFact 'originalProductCodeInstalledOnHost' ($installed -contains $origCode)
        Add-SpikeFact 'copyProductCodeDiffers' ($copyCode -ne $origCode)
        Add-SpikeFact 'copyProductCodeInstalledOnHost' ($installed -contains $copyCode)
        Add-SpikeFact 'copyUpgradeCodeDiffers' ($copyUpgrade -ne (Get-MsiValue $orig 'UpgradeCode'))
        Add-SpikeFact 'copyProductVersion' (Get-MsiValue $copy 'ProductVersion')
        if ($copyCode -eq $origCode -or ($installed -contains $copyCode)) { throw 'VERIFY: the copy still has an installed ProductCode; do not install it.' }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($orig)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($copy)
        Add-SpikeFact 'instanceMsi' $target
    }
    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
