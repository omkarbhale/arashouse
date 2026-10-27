# Store the password root has in a flavor's golden backup (ticket 35, docs/health.md). Run by the captain (or firstmate's
# elevated gate), as the Windows user whose file holds the password.
#
# A restore of the golden backup brings back the password the shipped CD database gives root. Every reset's health check
# logs in with it once, through the slot's own server, to make the free slot's random root password (ticket 32); without
# it a slot of a line with a stored licence fails its login check. This script reads the password from a file of
# ConvertFrom-SecureString output (the current Windows user's DPAPI, as the baseline build's -AdminPasswordFile takes it)
# and hands it to the broker's storeOotbRoot verb on the client's stdin. The broker keeps it as one machine-scope DPAPI
# blob, <root>\secrets\ootb-root-<flavor>.bin (SYSTEM and the broker only). The password is not printed, logged, written to
# another file or put in an argument list: the only output is which flavor was stored, or an error that names no value.
# Without -Apply it prints the plan and reads nothing. Windows PowerShell 5.1.
#
#   store-ootb-root.ps1 -Flavor 12sp9 -PasswordFile 'C:\aras_installations\spike\handoff\aras.dpapi' -Apply
#
# Exit: 0 stored (or the dry run); 1 the broker refused or failed; 2 a parameter or precondition is wrong (nothing was sent);
# 6 the broker could not be reached.
param(
    [Parameter(Mandatory = $true)][ValidateSet('12sp9', '23', '35')][string]$Flavor,
    [Parameter(Mandatory = $true)][string]$PasswordFile,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'

$Root = 'C:\aras_installations'
$Client = Join-Path $Root 'broker\app\broker\client.js'

function Stop-Script([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine("error: $Message")
    exit $Code
}

try {
    $full = [IO.Path]::GetFullPath($PasswordFile)
} catch {
    Stop-Script 2 '-PasswordFile is not a path.'
}

if (-not $Apply) {
    Write-Output "would do: decrypt the password in $full as the current Windows user (ConvertFrom-SecureString output)"
    Write-Output "would do: store it through the broker's storeOotbRoot verb as the golden backup's root password for $Flavor ($Root\secrets\ootb-root-$Flavor.bin)"
    Write-Output 'dry run: nothing was read or changed; add -Apply (elevated) to store it'
    exit 0
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Script 2 'run it elevated: the password file is read only through the captain-approved elevated session.'
}

if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { Stop-Script 2 "$full does not exist." }
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Stop-Script 2 "$node does not exist." }
if (-not (Test-Path -LiteralPath $Client -PathType Leaf)) { Stop-Script 2 "$Client does not exist: install the broker first (arashouse setup)." }

try {
    $secure = ConvertTo-SecureString -String ((Get-Content -LiteralPath $full -Raw).Trim())
} catch {
    Stop-Script 2 'the file does not decrypt as this Windows user (it must be ConvertFrom-SecureString output made by this user).'
}
if ($secure.Length -eq 0) { Stop-Script 2 'the file holds an empty password.' }

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $request = [ordered]@{ id = ('store-ootb-root-' + [guid]::NewGuid().ToString('N')); verb = 'storeOotbRoot'; args = [ordered]@{ flavor = $Flavor; password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } }
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $request -Compress -Depth 4))
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $request = $null
    $secure.Dispose()
}

# The request goes on the client's stdin only; the client adds the broker's token and prints the broker's one-line answer.
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = '"' + $Client + '"'
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [Text.Encoding]::UTF8
$process = [Diagnostics.Process]::Start($psi)
$stderr = $process.StandardError.ReadToEndAsync()
try {
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.Close()
} finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
}
$out = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
$null = $stderr.Result

$response = $null
try { $response = ($out.Trim() | ConvertFrom-Json) } catch { $response = $null }
if (-not $response) { Stop-Script 1 "the broker client answered nothing usable (exit $($process.ExitCode))." }
if ($response.ok -and $response.result.ok) {
    Write-Output "stored the golden backup's root password for $Flavor"
    exit 0
}
if (-not $response.ok) {
    # The broker's message names fields and flavors, never a value (src/broker/ootb-root.ts), and passes through redact.
    $code = 1
    if ($response.error.kind -eq 'Unreachable') { $code = 6 }
    Stop-Script $code "the broker answered $($response.error.kind): $($response.error.message)"
}
Stop-Script 1 'the broker did not store the password.'
