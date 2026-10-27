# Runs the ACL steps of a generated setup-host.ps1 (Protect-Root, New-Folder, Set-FolderAcl and the checks that read them
# back) on a scratch root the current user creates and so owns, which needs no elevation; for test/setup-host.test.ts.
# It loads the script's generated values and functions, not its main part, and prints one "<check>: <result>" line each.
# With -Cleanup it gives the current user full control of the scratch root again and deletes it.
param([Parameter(Mandatory)][string]$Script, [switch]$Cleanup)
$ErrorActionPreference = 'Stop'
$text = [IO.File]::ReadAllText($Script)
$start = $text.IndexOf('# ---- generated from')
$end = $text.IndexOf('# ---- main ----')
$Apply = $true
. ([scriptblock]::Create($text.Substring($start, $end - $start)))
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User

function Grant-Me([string]$Path) {
    # The owner may always rewrite a DACL.
    $sec = New-Object Security.AccessControl.DirectorySecurity
    $sec.SetAccessRuleProtection($true, $false)
    $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    (Get-Item -LiteralPath $Path -Force).SetAccessControl($sec)
}

if ($Cleanup) {
    if (Test-Path -LiteralPath $Root) {
        Grant-Me $Root
        foreach ($p in $Folders.Values) { if (Test-Path -LiteralPath $p) { Grant-Me $p } }
        Remove-Item -LiteralPath $Root -Recurse -Force
    }
    Write-Output "cleanup: $(-not (Test-Path -LiteralPath $Root))"
    exit 0
}

if ($me.Value -ne $WorkerSid) { throw 'the script must name the current user as the worker' }
$sids = Get-Sids $null
New-Folder $Root
$other = Join-Path $Root 'other'
New-Item -ItemType Directory -Path $other | Out-Null
# The ACEs, in any order: Windows keeps the parent's order when it re-propagates, and the order of allow ACEs does not matter.
$aces = { ([regex]::Matches((Get-Item -LiteralPath $other -Force).GetAccessControl('Access').GetSecurityDescriptorSddlForm('Access'), '\([^)]*\)') | ForEach-Object { $_.Value } | Sort-Object) -join '' }
$otherBefore = & $aces
$before = Get-RootDeviations
Write-Output "root before: $($before.Count)"
Protect-Root
$after = Get-RootDeviations
Write-Output "root after: $($after -join '; ')"
Write-Output "other unchanged: $($otherBefore -eq (& $aces))"
foreach ($name in $Folders.Keys) {
    New-Folder $Folders[$name]
    $plan = @{}
    foreach ($k in $FolderAcl[$name].Keys) { if ($sids[$k]) { $plan[$k] = $FolderAcl[$name][$k] } }
    $fresh = Get-FolderDeviations $Folders[$name] $plan $sids
    Set-FolderAcl $Folders[$name] $plan $sids
    $left = Get-FolderDeviations $Folders[$name] $plan $sids
    Write-Output "${name}: $($fresh.Count) -> $($left -join '; ')"
}
# A drifted ACL is seen, and a second Set-FolderAcl repairs it.
$staging = $Folders['staging']
$acl = (Get-Item -LiteralPath $staging -Force).GetAccessControl('Access')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-11')), 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
(Get-Item -LiteralPath $staging -Force).SetAccessControl($acl)
$stagingPlan = @{}
foreach ($k in $FolderAcl['staging'].Keys) { if ($sids[$k]) { $stagingPlan[$k] = $FolderAcl['staging'][$k] } }
$drift = Get-FolderDeviations $staging $stagingPlan $sids
Write-Output "drift: $($drift -join '; ')"
Set-FolderAcl $staging $stagingPlan $sids
$repaired = Get-FolderDeviations $staging $stagingPlan $sids
Write-Output "repaired: $($repaired.Count)"
