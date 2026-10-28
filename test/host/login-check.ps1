# login-check.ps1 (ticket 35's e2e, test/host/e2e-cycle.ts): does root log in to a slot with the golden backup's shipped
# password? (-User asks the same of another shipped user, for ticket 50's audit.) One OAuth password grant as the user, as the Aras clients make it (client_id IOMApp, the password as its MD5 hex),
# against http://localhost/ah-<flavor>-<NN> and the database arashouse_<flavor>_<NN>. The password is read from -PasswordFile,
# ConvertFrom-SecureString output that only this Windows user can decrypt (the spike's handoff aras.dpapi), and decrypted
# inside this process only. It prints only "login: ok" or the server's refusal (its error code and description, which name
# no password); never the password, its MD5 or the token. It changes nothing: one HTTP POST to the slot's own OAuth server.
# Not elevated. Exit 0 logged in; 1 refused or no answer; 2 a precondition.
param(
    [Parameter(Mandatory = $true)][ValidateSet('12sp9', '23', '35')][string]$Flavor,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d{2}$')][string]$Slot,
    [Parameter(Mandatory = $true)][string]$PasswordFile,
    [ValidateSet('root', 'admin', 'vadmin', 'authadmin', 'clientadmin', 'JobAgentUser')][string]$User = 'root'
)
$ErrorActionPreference = 'Stop'
$alias = "ah-$Flavor-$Slot"
$database = "arashouse_$($Flavor)_$Slot"
if (-not (Test-Path -LiteralPath $PasswordFile -PathType Leaf)) { [Console]::Error.WriteLine("error: $PasswordFile does not exist"); exit 2 }
try {
    $secure = ConvertTo-SecureString -String ((Get-Content -LiteralPath $PasswordFile -Raw).Trim())
} catch {
    [Console]::Error.WriteLine('error: the file does not decrypt as this Windows user'); exit 2
}
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $bytes = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $secure.Dispose()
}
$md5 = -join ([Security.Cryptography.MD5]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
[Array]::Clear($bytes, 0, $bytes.Length)
$body = "grant_type=password&scope=Innovator&client_id=IOMApp&username=$User&password=$md5&database=$database"
$md5 = $null
try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://localhost/$alias/OAuthServer/connect/token" -ContentType 'application/x-www-form-urlencoded' -Body $body -TimeoutSec 180
    $body = $null
    $json = $response.Content | ConvertFrom-Json
    if ($json.access_token) { Write-Output 'login: ok (an access token was issued; it is not printed)'; exit 0 }
    Write-Output "login: HTTP $($response.StatusCode) without a token"
    exit 1
} catch {
    $body = $null
    $failed = $_.Exception.Response
    if (-not $failed) { Write-Output "login: no answer: $($_.Exception.Message)"; exit 1 }
    $text = (New-Object IO.StreamReader($failed.GetResponseStream())).ReadToEnd()
    try { $e = $text | ConvertFrom-Json; Write-Output "login: refused: HTTP $([int]$failed.StatusCode) $($e.error): $($e.error_description)" } catch { Write-Output "login: refused: HTTP $([int]$failed.StatusCode)" }
    exit 1
}
