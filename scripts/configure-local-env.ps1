param(
    [Parameter(Mandatory = $true)]
    [string]$CookieFile,

    [Parameter(Mandatory = $false)]
    [string]$TwoCaptchaKey
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $CookieFile -PathType Leaf)) {
    throw "Cookie file does not exist: $CookieFile"
}

$cookie = (Get-Content -LiteralPath $CookieFile -Raw -Encoding UTF8).Trim()
if (
    $cookie.Length -lt 100 -or
    $cookie -notmatch '(^|;\s*)__session=' -or
    $cookie -notmatch '(^|;\s*)__client='
) {
    throw 'Cookie file must contain both __session and __client from an auth.suno.com request.'
}

if ($TwoCaptchaKey -and $TwoCaptchaKey -notmatch '^[A-Za-z0-9]{20,}$') {
    throw '2Captcha key format is invalid.'
}

function ConvertTo-DotEnvQuotedValue([string]$Value) {
    return $Value.Replace('\', '\\').Replace('"', '\"')
}

$envPath = Join-Path $PSScriptRoot '..\.env'
$lines = @(
    'SUNO_COOKIE="' + (ConvertTo-DotEnvQuotedValue $cookie) + '"'
    'TWOCAPTCHA_KEY="' + (ConvertTo-DotEnvQuotedValue $TwoCaptchaKey) + '"'
    'BROWSER=chromium'
    'BROWSER_GHOST_CURSOR=false'
    'BROWSER_LOCALE=en'
    'BROWSER_HEADLESS=true'
    'MANUAL_CAPTCHA=true'
)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines([IO.Path]::GetFullPath($envPath), $lines, $utf8NoBom)

$pairCount = ($cookie -split ';\s*' | Where-Object { $_ -match '^[^=;]+=.+' }).Count
Write-Output "Configured .env with $pairCount cookie pairs."
