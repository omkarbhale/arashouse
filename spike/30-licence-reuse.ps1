# Licence reuse test: does one licence value serve both slots, does it survive a recycle, and does the OOTB server need a key at all?
# The licence value is typed once at a hidden prompt, written to both slots' <License> element by this script, and never printed.
# Only booleans and the licence type are recorded. Dry run by default; -Apply makes changes (elevated). Windows PowerShell 5.1.
param(
    [switch]$Apply,
    [ValidateSet('12sp9', '23', '35')][string]$Flavor = '12sp9',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SuffixA = 'a',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SuffixB = 'b',
    # Recorded as lic_type; not secret.
    [string]$LicenceType = 'Unlimited',
    # Overrides, mainly for the guard tests.
    [string]$AliasA,
    [string]$AliasB
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

try {
    if (-not $AliasA) { $AliasA = (Get-SpikeNames -Flavor $Flavor -Suffix $SuffixA).Alias }
    if (-not $AliasB) { $AliasB = (Get-SpikeNames -Flavor $Flavor -Suffix $SuffixB).Alias }
    Assert-SpikeName -Kind Alias -Name $AliasA
    Assert-SpikeName -Kind Alias -Name $AliasB
    if ($LicenceType -notmatch '^[A-Za-z0-9 _-]{1,32}$') { throw 'PARAM: -LicenceType is not a plain word.' }
    $treeA = Assert-SpikePath -Path (Join-Path $script:SpikeRoot ("golden-build\" + $(if ($SuffixA -eq 'a') { $Flavor } else { "$Flavor-$SuffixA" }))) -Mode Read
    $treeB = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "slot-$Flavor-$SuffixB") -Mode Write

    Start-Spike -Name "30-licence-reuse-$Flavor" -Apply $Apply.IsPresent -NeedsElevation
    Add-SpikeFact 'licenceType' $LicenceType

    $ctx = @{ cfgA = $null; cfgB = $null; idA = $null; idB = $null; lic = $null; act = $null; pw = $null }

    function Set-LicenceAttrs([string]$configPath, [securestring]$lic, [securestring]$act) {
        # Rewrites lic_type / lic_key / act_key of <License>; a null secret blanks the attribute.
        $xml = New-Object Xml.XmlDocument
        $xml.PreserveWhitespace = $true
        $xml.Load($configPath)
        $node = $xml.SelectSingleNode('//License')
        if (-not $node) { throw 'CONFIG: no <License> element in the slot config.' }
        $node.SetAttribute('lic_type', $LicenceType)
        foreach ($pair in @(@('lic_key', $lic), @('act_key', $act))) {
            $value = ''
            if ($pair[1]) { $value = ConvertTo-SpikePlainText $pair[1] }
            $node.SetAttribute($pair[0], $value)
            $value = $null
        }
        $xml.Save($configPath)
    }

    function Get-LicenceFlag([string]$configPath) {
        $xml = New-Object Xml.XmlDocument
        $xml.Load($configPath)
        $node = $xml.SelectSingleNode('//License')
        return [bool]($node -and $node.GetAttribute('lic_key'))
    }

    function Test-BothLogins {
        $a = Test-SpikeArasLogin -Alias $AliasA -DatabaseId $ctx.idA -ArasPassword $ctx.pw
        $b = Test-SpikeArasLogin -Alias $AliasB -DatabaseId $ctx.idB -ArasPassword $ctx.pw
        return [ordered]@{ slotA = $a; slotB = $b }
    }

    Invoke-SpikeStep "locate both slots' InnovatorServerConfig.xml ($treeA and $treeB) and record whether each already holds a key (a boolean)" {
        $ctx.cfgA = Find-SpikeFile -Root $treeA -Name 'InnovatorServerConfig.xml'
        $ctx.cfgB = Find-SpikeFile -Root $treeB -Name 'InnovatorServerConfig.xml'
        if (-not $ctx.cfgA -or -not $ctx.cfgB) { throw 'PRECONDITION: run 10 and 20 first; a slot config is missing.' }
        $ctx.idA = Get-SpikeDbId -ConfigPath $ctx.cfgA
        $ctx.idB = Get-SpikeDbId -ConfigPath $ctx.cfgB
        Add-SpikeFact 'keyPresentBefore' ([ordered]@{ slotA = (Get-LicenceFlag $ctx.cfgA); slotB = (Get-LicenceFlag $ctx.cfgB) })
        $ctx.pw = Get-SpikeArasPassword
    }

    Invoke-SpikeStep 'phase 1: blank the key in both slots, recycle both pools, try to log in (does the OOTB server need a key at all?)' {
        Set-LicenceAttrs $ctx.cfgA $null $null
        Set-LicenceAttrs $ctx.cfgB $null $null
        Restart-SpikePools -Alias $AliasA
        Restart-SpikePools -Alias $AliasB
        Add-SpikeFact 'loginWithoutKey' (Test-BothLogins)
    }

    Invoke-SpikeStep 'prompt (hidden) for the licence key and the activation key (press Enter to skip the activation key)' {
        $ctx.lic = Read-SpikeSecret -Prompt 'Licence key lic_key (hidden)'
        $ctx.act = Read-SpikeSecret -Prompt 'Activation key act_key (hidden; Enter if there is none)' -AllowEmpty
        if ($ctx.act.Length -eq 0) { $ctx.act = $null }
    }

    Invoke-SpikeStep 'phase 2: write the same licence value into both slots, recycle both pools, log in to both' {
        Set-LicenceAttrs $ctx.cfgA $ctx.lic $ctx.act
        Set-LicenceAttrs $ctx.cfgB $ctx.lic $ctx.act
        Restart-SpikePools -Alias $AliasA
        Restart-SpikePools -Alias $AliasB
        Add-SpikeFact 'loginWithSameKeyInBoth' (Test-BothLogins)
    }

    Invoke-SpikeStep 'phase 3: recycle both pools again and log in to both (does it still work?)' {
        Restart-SpikePools -Alias $AliasA
        Restart-SpikePools -Alias $AliasB
        Add-SpikeFact 'loginAfterSecondRecycle' (Test-BothLogins)
    }

    Invoke-SpikeStep 'phase 4: stop and start both pools (a full pool restart) and log in to both' {
        Restart-SpikePools -Alias $AliasA -Stop
        Restart-SpikePools -Alias $AliasB -Stop
        Restart-SpikePools -Alias $AliasA -Start
        Restart-SpikePools -Alias $AliasB -Start
        Add-SpikeFact 'loginAfterPoolRestart' (Test-BothLogins)
    }

    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
