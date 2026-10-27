# Store one licence line's whole <License> element for the slots (ticket 34b, docs/secrets.md). Run elevated by the captain (or
# firstmate's elevated gate); the captain approves the source.
#
# It reads the <License> element (lic_key, act_key, lic_type, company) of one existing Aras install's InnovatorServerConfig.xml,
# READ ONLY, and hands the four values to the broker's storeLicence verb on the client's stdin. The broker keeps them as one
# machine-scope DPAPI blob, <root>\secrets\licence-<line>.bin (SYSTEM and the broker only), which every slot provision and reset of
# the line renders into the slot's config. Nothing else of the install is read, and nothing of it is written, backed up or changed.
# No value is printed, logged, written to a file or put in an argument list: the only output is which line was stored, or an error
# that names no value. Without -Apply it prints the plan and reads nothing. Windows PowerShell 5.1.
#
#   store-licence.ps1 -Line 12 -SourceConfig 'C:\Program Files (x86)\<install>\Innovator\InnovatorServerConfig.xml' -Apply
#
# Exit: 0 stored (or the dry run); 1 the broker refused or failed; 2 a parameter or precondition is wrong (nothing was sent);
# 6 the broker could not be reached.
param(
    [Parameter(Mandatory = $true)][ValidateSet('12', '14')][string]$Line,
    # An InnovatorServerConfig.xml directly in an Aras install root under Program Files, as spike/30-licence-reuse.ps1 reads it.
    [Parameter(Mandatory = $true)][string]$SourceConfig,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'

$Root = 'C:\aras_installations'
$Client = Join-Path $Root 'broker\app\broker\client.js'
$Attributes = @('lic_key', 'act_key', 'lic_type', 'company')

function Stop-Script([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine("error: $Message")
    exit $Code
}

try {
    $full = [IO.Path]::GetFullPath($SourceConfig)
} catch {
    Stop-Script 2 '-SourceConfig is not a path.'
}
if ($full -notmatch '^C:\\Program Files( \(x86\))?\\Aras[^\\]*\\Innovator\\InnovatorServerConfig\.xml$') {
    Stop-Script 2 '-SourceConfig must be <Aras install root>\Innovator\InnovatorServerConfig.xml under Program Files.'
}

if (-not $Apply) {
    Write-Output "would do: read the <License> element ($($Attributes -join ', ')) of $full, read only"
    Write-Output "would do: store it through the broker's storeLicence verb as the licence of line $Line ($Root\secrets\licence-$Line.bin)"
    Write-Output 'dry run: nothing was read or changed; add -Apply (elevated) to store it'
    exit 0
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Script 2 'run it elevated: the source is read only through the captain-approved elevated session.'
}
if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { Stop-Script 2 "$full does not exist." }
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Stop-Script 2 "$node does not exist." }
if (-not (Test-Path -LiteralPath $Client -PathType Leaf)) { Stop-Script 2 "$Client does not exist: install the broker first (arashouse setup)." }

# Read only: XmlDocument.Load opens the file for reading and shares it.
$xml = New-Object Xml.XmlDocument
$xml.Load($full)
$element = $xml.SelectSingleNode('/Innovator/License')
if (-not $element -or -not $element.GetAttribute('lic_key')) { Stop-Script 2 "the source config has no <License lic_key>." }
$licence = [ordered]@{}
foreach ($a in $Attributes) { $licence[$a] = $element.GetAttribute($a) }
$xml = $null; $element = $null

$request = [ordered]@{ id = ('store-licence-' + [guid]::NewGuid().ToString('N')); verb = 'storeLicence'; args = [ordered]@{ line = $Line; licence = $licence } }
$bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $request -Compress -Depth 4))
$request = $null; $licence = $null

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
    Write-Output "stored the licence for line $Line"
    exit 0
}
if (-not $response.ok) {
    # The broker's message names fields and lines, never a value (src/broker/licence-verbs.ts), and passes through redact.
    $code = 1
    if ($response.error.kind -eq 'Unreachable') { $code = 6 }
    Stop-Script $code "the broker answered $($response.error.kind): $($response.error.message)"
}
Stop-Script 1 'the broker did not store the licence.'
