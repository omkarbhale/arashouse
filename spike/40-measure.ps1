# Measurements for the reset budget: database restore time, robocopy /MIR time clean, dirty and very dirty (8 and 16 threads, optionally
# with a Defender exclusion), cold and warm start, per-slot working set active and idle, database and tree size.
# The mirror is measured on a scratch copy of the baseline, never on a served slot. Dry run by default; -Apply makes changes
# (elevated). Windows PowerShell 5.1. Results are numbers only.
param(
    [switch]$Apply,
    [ValidateSet('12sp9', '23', '35')][string]$Flavor = '12sp9',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SourceSuffix = 'a',
    [ValidatePattern('^[a-z0-9]{1,8}$')][string]$SlotSuffix = 'b',
    [ValidateSet('Sa', 'Windows')][string]$SqlAuth = 'Sa',
    [string]$BakPath,
    # Repeat each timed step this many times and record all runs.
    [ValidateRange(1, 5)][int]$Repeat = 3,
    # Add (and afterwards remove) a Windows Defender exclusion for the spike folder and repeat the mirror timings with it.
    [switch]$TestDefenderExclusion
)
. "$PSScriptRoot/lib/SpikeCommon.ps1"

try {
    $golden = Assert-SpikePath -Path (Join-Path $script:SpikeRoot ("golden-build\" + $(if ($SourceSuffix -eq 'a') { $Flavor } else { "$Flavor-$SourceSuffix" }))) -Mode Read
    $scratchRoot = Assert-SpikePath -Path (Join-Path $script:SpikeRoot "measure-$Flavor") -Mode Write
    $scratch = Join-Path $scratchRoot 'tree'
    $srcNames = Get-SpikeNames -Flavor $Flavor -Suffix $SourceSuffix
    $slotNames = Get-SpikeNames -Flavor $Flavor -Suffix $SlotSuffix
    $scratchDb = "arashouse_spike_${Flavor}_m"
    Assert-SpikeName -Kind Database -Name $scratchDb
    Assert-SpikeName -Kind Alias -Name $srcNames.Alias
    Assert-SpikeName -Kind Alias -Name $slotNames.Alias
    if ($BakPath) { $BakPath = Assert-SpikePath -Path $BakPath -Mode Read }

    Start-Spike -Name "40-measure-$Flavor" -Apply $Apply.IsPresent -NeedsElevation
    $ctx = @{ conn = $null; pw = $null; sqlPassword = $null; dirty = $null; defenderAdded = $false }

    function Invoke-DirtyFiles([string]$tree, [int]$count, [string]$tag) {
        # Adds $count small files across the tree and touches 5% as many existing files, like runtime changes.
        $dirs = @(Get-ChildItem -LiteralPath $tree -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 200)
        if ($dirs.Count -eq 0) { $dirs = @(Get-Item -LiteralPath $tree) }
        for ($i = 0; $i -lt $count; $i++) {
            $d = $dirs[$i % $dirs.Count].FullName
            [IO.File]::WriteAllText((Join-Path $d "spike-dirty-$tag-$i.tmp"), 'x')
        }
        $existing = @(Get-ChildItem -LiteralPath $tree -File -Recurse -Depth 3 -Filter '*.config' -ErrorAction SilentlyContinue | Select-Object -First ([math]::Max(1, [int]($count * 0.05))))
        foreach ($f in $existing) { (Get-Item -LiteralPath $f.FullName).LastWriteTime = [DateTime]::Now }
    }

    function Measure-Mirrors([string]$label) {
        $result = [ordered]@{}
        foreach ($threads in @(8, 16)) {
            $row = [ordered]@{}
            $row.clean = @(1..$Repeat | ForEach-Object { (Invoke-SpikeRobocopy -Source $golden -Destination $scratch -Mirror -Threads $threads).seconds })
            $row.dirty = @(1..$Repeat | ForEach-Object {
                Invoke-DirtyFiles $scratch 20 "d$threads"
                (Invoke-SpikeRobocopy -Source $golden -Destination $scratch -Mirror -Threads $threads).seconds })
            $row.veryDirty = @(1..$Repeat | ForEach-Object {
                Invoke-DirtyFiles $scratch 500 "v$threads"
                (Invoke-SpikeRobocopy -Source $golden -Destination $scratch -Mirror -Threads $threads).seconds })
            $result["mt$threads"] = $row
        }
        Add-SpikeFact "mirrorSeconds_$label" $result
    }

    Invoke-SpikeStep "make the scratch copy $scratch from the baseline $golden and record tree size, file count and copy time" {
        New-Item -ItemType Directory -Path $scratchRoot | Out-Null
        $r = Invoke-SpikeRobocopy -Source $golden -Destination $scratch -Threads 16
        Add-SpikeFact 'scratchCopySeconds' $r.seconds
        Add-SpikeFact 'tree' (Get-SpikeTreeStats -Path $scratch)
    }

    Invoke-SpikeStep 'time robocopy /MIR golden -> scratch with 8 and 16 threads: clean, dirty (20 files) and very dirty (500 files), repeated' {
        Measure-Mirrors 'defenderDefault'
    }

    if ($TestDefenderExclusion) {
        Invoke-SpikeStep "add a Defender exclusion for $($script:SpikeRoot) (only if none covers it), repeat the mirror timings, then remove it" {
            $pref = Get-MpPreference
            $had = @($pref.ExclusionPath) -contains $script:SpikeRoot
            Add-SpikeFact 'defenderExclusionAlreadyPresent' $had
            if (-not $had) { Add-MpPreference -ExclusionPath $script:SpikeRoot; $ctx.defenderAdded = $true }
            try { Measure-Mirrors 'defenderExcluded' }
            finally { if ($ctx.defenderAdded) { Remove-MpPreference -ExclusionPath $script:SpikeRoot; $ctx.defenderAdded = $false } }
        }
    }

    if ($SqlAuth -eq 'Sa') {
        Invoke-SpikeStep 'prompt (hidden) for the SQL sa password' { $ctx.sqlPassword = Read-SpikeSecret -Prompt 'SQL sa password (hidden)' }
    }

    Invoke-SpikeStep "time the database restore of the shipped backup: new database $scratchDb, then RESTORE ... WITH REPLACE $Repeat times (sa)" {
        $ctx.conn = if ($SqlAuth -eq 'Sa') { New-SpikeSqlConnection -Auth Sa -Password $ctx.sqlPassword } else { New-SpikeSqlConnection -Auth Windows }
        if (-not $script:BakPath) {
            $script:BakPath = (Get-ChildItem -LiteralPath $golden -Recurse -Filter 'CoreAndSolutions*.bak' -File | Select-Object -First 1).FullName
        }
        $sqldata = Assert-SpikePath -Path (Join-Path $script:SpikeRoot 'sqldata') -Mode Write
        if (-not (Test-Path -LiteralPath $sqldata)) { New-Item -ItemType Directory -Path $sqldata | Out-Null }
        Grant-SpikeSqlServiceAccess -Path $sqldata -Right Modify
        Grant-SpikeSqlServiceAccess -Path (Split-Path -Parent $script:BakPath) -Right Read
        Add-SpikeFact 'restoreNewSeconds' (Restore-SpikeDatabase -Connection $ctx.conn -BackupPath $script:BakPath -Database $scratchDb)
        Add-SpikeFact 'restoreReplaceSeconds' @(1..$Repeat | ForEach-Object { Restore-SpikeDatabase -Connection $ctx.conn -BackupPath $script:BakPath -Database $scratchDb -Replace })
        $sizes = Invoke-SpikeSql -Connection $ctx.conn -Query "SELECT DB_NAME(database_id) AS db, CAST(SUM(size) * 8.0 / 1024 AS decimal(10,1)) AS mb FROM sys.master_files WHERE DB_NAME(database_id) LIKE N'arashouse[_]spike[_]%' GROUP BY database_id"
        Add-SpikeFact 'spikeDatabaseSizesMb' @($sizes | ForEach-Object { [ordered]@{ database = $_.db; mb = [double]$_.mb } })
    }

    Invoke-SpikeStep "cold start: stop, start and request /$($slotNames.Alias)/Client/ for the slot and the baseline; then a warm request" {
        $ctx.pw = Get-SpikeArasPassword
        $out = [ordered]@{}
        foreach ($n in @($slotNames, $srcNames)) {
            Restart-SpikePools -Alias $n.Alias -Stop
            Start-Sleep -Seconds 5
            Restart-SpikePools -Alias $n.Alias -Start
            $cold = Measure-SpikeHttp "http://localhost/$($n.Alias)/Client/"
            $warm = Measure-SpikeHttp "http://localhost/$($n.Alias)/Client/"
            $out[$n.Alias] = [ordered]@{ coldSeconds = $cold.seconds; coldStatus = $cold.status; warmSeconds = $warm.seconds; warmStatus = $warm.status }
        }
        Add-SpikeFact 'startSeconds' $out
    }

    Invoke-SpikeStep 'working set per slot: active (logged in, one OData request) and idle (pool idle timeout set to 1 minute, then 90 s wait); SQL process memory before and after' {
        $mem = Invoke-SpikeSql -Connection $ctx.conn -Query 'SELECT physical_memory_in_use_kb / 1024 AS mb FROM sys.dm_os_process_memory'
        Add-SpikeFact 'sqlProcessMbBefore' ([int]$mem[0].mb)
        $result = [ordered]@{}
        foreach ($n in @($slotNames, $srcNames)) {
            $tree = if ($n.Alias -eq $srcNames.Alias) { $golden } else { Join-Path $script:SpikeRoot "slot-$Flavor-$SlotSuffix" }
            $cfg = Find-SpikeFile -Root $tree -Name 'InnovatorServerConfig.xml'
            $id = Get-SpikeDbId -ConfigPath $cfg
            $token = Get-SpikeArasToken -Alias $n.Alias -DatabaseId $id -ArasPassword $ctx.pw
            $odata = 0
            if ($token) {
                $plain = ConvertTo-SpikePlainText $token
                try {
                    $req = [Net.HttpWebRequest]::Create("http://localhost/$($n.Alias)/Server/odata/User?`$top=1")
                    $req.Headers.Add('Authorization', "Bearer $plain")
                    $req.Timeout = 120000
                    try { $res = $req.GetResponse(); $odata = [int]$res.StatusCode; $res.Close() } catch [Net.WebException] { if ($_.Exception.Response) { $odata = [int]$_.Exception.Response.StatusCode } }
                } finally { $plain = $null }
            }
            $result[$n.Alias] = [ordered]@{ loggedIn = [bool]$token; odataStatus = $odata; activeWorkingSetMb = (Get-SpikePoolWorkingSetMb -Alias $n.Alias) }
        }
        $mem = Invoke-SpikeSql -Connection $ctx.conn -Query 'SELECT physical_memory_in_use_kb / 1024 AS mb FROM sys.dm_os_process_memory'
        Add-SpikeFact 'sqlProcessMbAfterActive' ([int]$mem[0].mb)
        $mgr = Get-SpikeIisManager
        try {
            foreach ($pool in $mgr.ApplicationPools) {
                if ($pool.Name -like 'ah-spike-*') { Assert-SpikeName -Kind Pool -Name $pool.Name; $pool.ProcessModel.IdleTimeout = [TimeSpan]::FromMinutes(1) }
            }
            $mgr.CommitChanges()
        } finally { $mgr.Dispose() }
        Start-Sleep -Seconds 90
        foreach ($n in @($slotNames, $srcNames)) { $result[$n.Alias].idleWorkingSetMb = (Get-SpikePoolWorkingSetMb -Alias $n.Alias) }
        Add-SpikeFact 'workingSet' $result
    }

    if ($ctx.conn) { $ctx.conn.Dispose() }
    Complete-Spike
} catch {
    Exit-SpikeFailure $_.Exception.Message
}
