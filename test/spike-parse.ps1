# Parse check for the spike scripts: prints one line per syntax error, then "errors=<n>". Used by test/spike.test.ts.
param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Files)
$bad = 0
foreach ($f in $Files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
    foreach ($e in $errors) { Write-Output ("{0}:{1}: {2}" -f (Split-Path -Leaf $f), $e.Extent.StartLineNumber, $e.Message); $bad++ }
}
Write-Output "errors=$bad"
