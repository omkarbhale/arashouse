# Licence reuse test: does one licence value serve both slots, does it survive a recycle, and does the OOTB server need a key at all?
# The licence value is typed once at a hidden prompt, written to both slots' <License> element by this script, and never printed.
# Only booleans and the licence type are recorded. Dry run by default; -Apply makes changes (elevated). Windows PowerShell 5.1.
param(
    [switch]$Apply,
    [ValidateSet('12sp9', '23', '35')][string]$Flavor = '12sp9',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SuffixA = 'a',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SuffixB = 'b',
    # Recorded as lic_type; not secret. With -LicenceSourceConfig the source's lic_type is used instead.
    [string]$LicenceType = 'Unlimited',
    # Read lic_key, act_key, lic_type and company from another install's InnovatorServerConfig.xml instead of prompting (the captain's choice,
    # 2026-10-27: "Pick up license key from any of my already Aras installed Aras"). The file is only read; the key is never printed.
    # Several sources are tried in order, each in both slots (ticket 07: is a 12.x key refused by 14.0.9, is a 14.0 SP18 key accepted?);
    # the first one both slots accept goes on to the recycle and restart phases. A source file that does not exist is recorded and skipped.
    [string[]]$LicenceSourceConfig,
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
    $sources = @()
    # powershell -File passes an array parameter as one string, so several paths may also be given as one, separated by '|' (not valid in a path).
    foreach ($source in @($LicenceSourceConfig | ForEach-Object { $_ -split '\|' } | Where-Object { $_ })) {
        # Read-only access to one file of an existing install: only an InnovatorServerConfig.xml directly in an Aras root under Program Files.
        $full = ConvertTo-SpikeFullPath $source
        if ($full -notmatch '^C:\\Program Files( \(x86\))?\\(Aras[^\\]*)\\Innovator\\InnovatorServerConfig\.xml$') { throw "PARAM: -LicenceSourceConfig must be <Aras root>\Innovator\InnovatorServerConfig.xml under Program Files." }
        # The label is the install root's folder name (Aras12, Aras28): names only, never the key.
        $sources += [pscustomobject]@{ path = $full; label = $Matches[2] }
    }
    $treeA = Assert-SpikePath -Path (Join-Path $script:SpikeRoot ("golden-build\" + $(if ($SuffixA -eq 'a') { $Flavor } else { "$Flavor-$SuffixA" }))) -Mode Read
    $treeB = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "slot-$Flavor-$SuffixB") -Mode Write

    Start-Spike -Name "30-licence-reuse-$Flavor" -Apply $Apply.IsPresent -NeedsElevation
    Add-SpikeFact 'licenceType' $LicenceType

    $ctx = @{ cfgA = $null; cfgB = $null; idA = $null; idB = $null; pw = $null; accepted = $null; bySource = [ordered]@{} }

    function Set-LicenceAttrs([string]$configPath, $licence) {
        # Rewrites lic_type / lic_key / act_key (and company) of <License>; a null licence blanks the key attributes.
        $xml = New-Object Xml.XmlDocument
        $xml.PreserveWhitespace = $true
        $xml.Load($configPath)
        $node = $xml.SelectSingleNode('//License')
        if (-not $node) { throw 'CONFIG: no <License> element in the slot config.' }
        $node.SetAttribute('lic_type', $(if ($licence -and $licence.type) { $licence.type } else { $LicenceType }))
        if ($licence -and $null -ne $licence.company) { $node.SetAttribute('company', $licence.company) }
        foreach ($pair in @(@('lic_key', $(if ($licence) { $licence.lic } else { $null })), @('act_key', $(if ($licence) { $licence.act } else { $null })))) {
            $value = ''
            if ($pair[1]) { $value = ConvertTo-SpikePlainText $pair[1] }
            $node.SetAttribute($pair[0], $value)
            $value = $null
        }
        $xml.Save($configPath)
    }

    function Read-LicenceSource([string]$path) {
        # lic_key and act_key become SecureStrings registered for the leak scan; lic_type and company are not secret.
        $src = New-Object Xml.XmlDocument
        $src.Load($path)
        $node = $src.SelectSingleNode('//License')
        if (-not $node -or -not $node.GetAttribute('lic_key')) { throw "SOURCE: $path has no lic_key." }
        $licence = [pscustomobject]@{ lic = $null; act = $null; type = $node.GetAttribute('lic_type'); company = $node.GetAttribute('company') }
        foreach ($name in @('lic_key', 'act_key')) {
            $value = $node.GetAttribute($name)
            $secure = $null
            if ($value) {
                $secure = New-Object Security.SecureString
                foreach ($c in $value.ToCharArray()) { $secure.AppendChar($c) }
                $secure.MakeReadOnly()
                Register-SpikeSecret $secure
            }
            if ($name -eq 'lic_key') { $licence.lic = $secure } else { $licence.act = $secure }
            $value = $null
        }
        return $licence
    }

    function Get-LicenceFlag([string]$configPath) {
        $xml = New-Object Xml.XmlDocument
        $xml.Load($configPath)
        $node = $xml.SelectSingleNode('//License')
        return [bool]($node -and $node.GetAttribute('lic_key'))
    }

    function Test-BothLogins {
        $a = Test-SpikeArasLogin -Alias $AliasA -DatabaseId $ctx.idA -ArasPassword $ctx.pw
        $errA = $script:SpikeLastLoginError
        $b = Test-SpikeArasLogin -Alias $AliasB -DatabaseId $ctx.idB -ArasPassword $ctx.pw
        $errB = $script:SpikeLastLoginError
        return [ordered]@{ slotA = $a; slotB = $b; refusalA = $(if ($a) { $null } else { $errA }); refusalB = $(if ($b) { $null } else { $errB }) }
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
        Set-LicenceAttrs $ctx.cfgA $null
        Set-LicenceAttrs $ctx.cfgB $null
        Restart-SpikePools -Alias $AliasA
        Restart-SpikePools -Alias $AliasB
        Add-SpikeFact 'loginWithoutKey' (Test-BothLogins)
    }

    function Test-Licence([string]$label, $licence) {
        # Writes one licence value into both slots, recycles both, and logs in to both. The first value both slots accept is kept.
        Set-LicenceAttrs $ctx.cfgA $licence
        Set-LicenceAttrs $ctx.cfgB $licence
        Restart-SpikePools -Alias $AliasA
        Restart-SpikePools -Alias $AliasB
        $r = Test-BothLogins
        $ctx.bySource[$label] = [ordered]@{ licenceType = $licence.type; hasActKey = [bool]$licence.act; login = $r }
        if (-not $ctx.accepted -and $r.slotA -and $r.slotB) { $ctx.accepted = [pscustomobject]@{ label = $label; licence = $licence } }
    }

    if ($sources.Count -gt 0) {
        foreach ($source in $sources) {
            Invoke-SpikeStep "phase 2 ($($source.label)): read the licence (lic_key, act_key, lic_type, company) from $($source.path) (read only; the key is never printed), write it into both slots, recycle both pools, log in to both" {
                if (-not (Test-Path -LiteralPath $source.path)) { $ctx.bySource[$source.label] = [ordered]@{ sourceMissing = $true }; return }
                # A source that cannot be read or used is recorded by its error (which never holds the key) and the next one is tried.
                try { Test-Licence $source.label (Read-LicenceSource $source.path) } catch { $ctx.bySource[$source.label] = [ordered]@{ error = $_.Exception.Message } }
            }
        }
    } else {
        Invoke-SpikeStep 'phase 2: prompt (hidden) for the licence key and the activation key (press Enter to skip the activation key), write the same value into both slots, recycle both pools, log in to both' {
            $lic = Read-SpikeSecret -Prompt 'Licence key lic_key (hidden)'
            $act = Read-SpikeSecret -Prompt 'Activation key act_key (hidden; Enter if there is none)' -AllowEmpty
            if ($act.Length -eq 0) { $act = $null }
            Test-Licence 'prompted' ([pscustomobject]@{ lic = $lic; act = $act; type = $LicenceType; company = $null })
        }
    }

    Invoke-SpikeStep 'record the result per licence source, and put back the first licence both slots accepted (the later phases run on it; none accepted: they are skipped)' {
        Add-SpikeFact 'loginBySource' $ctx.bySource
        Add-SpikeFact 'acceptedSource' $(if ($ctx.accepted) { $ctx.accepted.label } else { $null })
        if ($ctx.accepted) {
            Add-SpikeFact 'loginWithSameKeyInBoth' $ctx.bySource[$ctx.accepted.label].login
            Add-SpikeFact 'licenceType' $ctx.accepted.licence.type
            Set-LicenceAttrs $ctx.cfgA $ctx.accepted.licence
            Set-LicenceAttrs $ctx.cfgB $ctx.accepted.licence
        }
    }

    Invoke-SpikeStep 'phase 3: recycle both pools again and log in to both (does it still work?)' {
        if (-not $ctx.accepted) { return }
        Restart-SpikePools -Alias $AliasA
        Restart-SpikePools -Alias $AliasB
        Add-SpikeFact 'loginAfterSecondRecycle' (Test-BothLogins)
    }

    Invoke-SpikeStep 'phase 4: stop and start both pools (a full pool restart) and log in to both' {
        if (-not $ctx.accepted) { return }
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
