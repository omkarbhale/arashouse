# Loads the pure helpers of scripts/host-tuning.ps1 (by AST, without running the script) and prints one result per case, for
# test/host-tuning.test.ts. Each case line is "Function|arg1|arg2|..."; the output line is the result, with CR LF shown as \n.
param([Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][string]$CaseFile)
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)
foreach ($name in @('Read-WslConfigValue')) {
    $fn = $ast.Find({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name }, $true)
    . ([scriptblock]::Create($fn.Extent.Text))
}
foreach ($line in [IO.File]::ReadAllLines($CaseFile)) {
    if (-not $line) { continue }
    $parts = $line.Split('|') | ForEach-Object { $_.Replace('\n', "`n") }
    $fnArgs = @($parts | Select-Object -Skip 1)
    $r = & $parts[0] @fnArgs
    Write-Output ([string]$r).Replace("`r`n", '\n')
}
