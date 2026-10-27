# audit-leak-check.ps1 (ticket 35's e2e, test/host/e2e-cycle.ts): is any of a cycle's lease passwords in the broker's audit
# log or service log? Run elevated by firstmate's gate, because C:\aras_installations\logs is Administrators-only.
#
# -PasswordsFile is the cycle's staging\e2e-<flavor>\leak-cycle-<n>.dpapi: one ConvertFrom-SecureString line per password,
# that only the Windows user who wrote it can decrypt. Each line is decrypted inside this process only, and every file under
# C:\aras_installations\logs is searched for each password. It prints only the file names with their match counts and a total;
# never a password. It reads the logs and changes nothing of them; after the search it deletes the passwords file.
#
#   audit-leak-check.ps1 -PasswordsFile 'C:\aras_installations\staging\e2e-12sp9\leak-cycle-1.dpapi'
#
# Exit: 0 no password found; 1 a password was found; 2 a parameter or precondition is wrong (nothing was read).
param(
    [Parameter(Mandatory = $true)][string]$PasswordsFile
)
$ErrorActionPreference = 'Stop'

$Root = 'C:\aras_installations'
$Logs = Join-Path $Root 'logs'

function Stop-Script([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine("error: $Message")
    exit $Code
}

try {
    $full = [IO.Path]::GetFullPath($PasswordsFile)
} catch {
    Stop-Script 2 '-PasswordsFile is not a path.'
}
if (-not $full.StartsWith("$Root\staging\", [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Script 2 "-PasswordsFile must be under $Root\staging\."
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Script 2 "run it elevated: $Logs is readable only by Administrators."
}
if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { Stop-Script 2 "$full does not exist." }
if (-not (Test-Path -LiteralPath $Logs -PathType Container)) { Stop-Script 2 "$Logs does not exist." }

$passwords = New-Object System.Collections.Generic.List[string]
try {
    foreach ($line in (Get-Content -LiteralPath $full)) {
        if (-not $line.Trim()) { continue }
        $secure = ConvertTo-SecureString -String $line.Trim()
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $passwords.Add([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            $secure.Dispose()
        }
    }
} catch {
    Stop-Script 2 'the file does not decrypt as this Windows user.'
}
if ($passwords.Count -eq 0) { Stop-Script 2 "$full holds no password." }

$total = 0
foreach ($file in (Get-ChildItem -LiteralPath $Logs -File -Recurse)) {
    $text = [IO.File]::ReadAllText($file.FullName)
    $count = 0
    foreach ($p in $passwords) {
        $at = $text.IndexOf($p, [StringComparison]::Ordinal)
        while ($at -ge 0) { $count++; $at = $text.IndexOf($p, $at + $p.Length, [StringComparison]::Ordinal) }
    }
    $text = $null
    Write-Output "$($file.FullName): $count"
    $total += $count
}
$passwords.Clear()
Remove-Item -LiteralPath $full -Force
Write-Output "total: $total ($full deleted)"
if ($total -eq 0) { exit 0 }
exit 1
