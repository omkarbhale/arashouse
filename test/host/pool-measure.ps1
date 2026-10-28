# pool-measure.ps1 (ticket 37, docs/pool.md): how much disk does each provisioned slot use? Run elevated by firstmate's
# gate, because a slot's database files (C:\aras_installations\sqldata) and vault folder are not readable by the worker.
#
# For every slot folder C:\aras_installations\slots\<flavor>\<NN> it sums the files of the slot's tree, of its vault folder
# vaults\<flavor>-<NN>, of its database files sqldata\arashouse_<flavor>_<NN>.mdf and _log.ldf, and of ASP.NET's temporary
# files of its alias ah-<flavor>-<NN>; then each golden\<flavor> folder, and the free space of the install root's drive.
# It reads sizes only: no file's contents, nothing under secrets\ or logs\, nothing outside the pool's own names. It
# changes nothing and prints no secret.
#
#   pool-measure.ps1
#
# Exit: 0 measured; 2 a precondition is wrong (nothing was read).
$ErrorActionPreference = 'Stop'

$Root = 'C:\aras_installations'
$Flavors = @('12sp9', '23', '35')

function Stop-Script([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine("error: $Message")
    exit $Code
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Script 2 "run it elevated: $Root\sqldata and $Root\vaults are readable only by Administrators and the broker."
}
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Stop-Script 2 "$Root does not exist." }

# Files and bytes under a folder, not following junctions; a missing folder is 0 files.
function Measure-Folder([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return [pscustomobject]@{ Files = 0; Bytes = [long]0 } }
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -Attributes !ReparsePoint -ErrorAction SilentlyContinue)
    $bytes = [long]0
    foreach ($f in $files) { $bytes += $f.Length }
    return [pscustomobject]@{ Files = $files.Count; Bytes = $bytes }
}

function Measure-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [long]0 }
    return [long](Get-Item -LiteralPath $Path -Force).Length
}

function MB([long]$Bytes) { return '{0:N1}' -f ($Bytes / 1MB) }

$aspTemp = @(
    "$env:windir\Microsoft.NET\Framework64\v4.0.30319\Temporary ASP.NET Files",
    "$env:windir\Microsoft.NET\Framework\v4.0.30319\Temporary ASP.NET Files"
)

Write-Output 'slot      tree_files  tree_MB  vault_MB  mdf_MB  ldf_MB  aspnet_MB  total_MB'
$sum = [long]0
foreach ($flavor in $Flavors) {
    $flavorDir = Join-Path $Root "slots\$flavor"
    if (-not (Test-Path -LiteralPath $flavorDir -PathType Container)) { continue }
    foreach ($dir in @(Get-ChildItem -LiteralPath $flavorDir -Directory -Force | Where-Object { $_.Name -match '^\d\d$' } | Sort-Object Name)) {
        $nn = $dir.Name
        $tree = Measure-Folder $dir.FullName
        $vault = Measure-Folder (Join-Path $Root "vaults\$flavor-$nn")
        $mdf = Measure-File (Join-Path $Root "sqldata\arashouse_${flavor}_$nn.mdf")
        $ldf = Measure-File (Join-Path $Root "sqldata\arashouse_${flavor}_${nn}_log.ldf")
        $asp = [long]0
        foreach ($base in $aspTemp) {
            $alias = Join-Path $base "ah-$flavor-$nn"
            $asp += (Measure-Folder $alias).Bytes
        }
        $total = $tree.Bytes + $vault.Bytes + $mdf + $ldf + $asp
        $sum += $total
        Write-Output ('{0,-9} {1,10}  {2,7}  {3,8}  {4,6}  {5,6}  {6,9}  {7,8}' -f "$flavor-$nn", $tree.Files, (MB $tree.Bytes), (MB $vault.Bytes), (MB $mdf), (MB $ldf), (MB $asp), (MB $total))
    }
}
Write-Output ('slots total: {0} MB' -f (MB $sum))

$goldens = [long]0
foreach ($flavor in $Flavors) {
    $g = Measure-Folder (Join-Path $Root "golden\$flavor")
    $goldens += $g.Bytes
    Write-Output ('golden {0}: {1} files, {2} MB' -f $flavor, $g.Files, (MB $g.Bytes))
}
Write-Output ('goldens total: {0} MB' -f (MB $goldens))

$drive = Get-PSDrive -Name ($Root.Substring(0, 1))
Write-Output ('drive {0}: {1:N1} GB free of {2:N1} GB' -f $drive.Name, ($drive.Free / 1GB), (($drive.Used + $drive.Free) / 1GB))
exit 0
