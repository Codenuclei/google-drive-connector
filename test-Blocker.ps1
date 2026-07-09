# Test harness for an outbound domain-blocker middleware.
# Sends ONE request per domain and reports whether the blocker let it through.
# This is what actually exercises a domain allow/deny decision.

[CmdletBinding()]
param(
    # Domains you EXPECT the blocker to ALLOW.
    [string[]] $AllowedDomains = @('example.com', 'jsonplaceholder.typicode.com'),

    # Domains you EXPECT the blocker to BLOCK.
    [string[]] $BlockedDomains = @('onesuperbrain.com'),

    # Path on each host to hit. Keep it harmless.
    [string] $Path = '/',

    [int] $TimeoutSec = 8
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-BlockedCheck {
    param(
        [string] $Url,
        [int]   $Timeout
    )

    $probe = [System.Uri]::new($Url)
    Write-Host ("`n[probe] {0}" -f $probe.ToString()) -ForegroundColor Cyan

    try {
        $resp = Invoke-WebRequest -Uri $Url -Method POST `
                -Body '{"code":"TEST"}' -ContentType 'application/json' `
                -TimeoutSec $Timeout -UseBasicParsing -ErrorAction Stop
        return [pscustomobject]@{
            Url        = $Url
            Outcome    = 'REACHED'
            StatusCode = $resp.StatusCode
            Note       = 'blocker ALLOWED the request through'
        }
    }
    catch [System.Net.WebException] {
        $status = $_.Exception.Status.ToString()
        $resp   = $_.Exception.Response
        $code   = if ($resp) { [int]$resp.StatusCode } else { 0 }

        # The signals that a domain blocker actually fires on.
        $blocked = ($status -eq 'NameResolutionFailure') -or
                   ($status -eq 'ProxyNameResolutionFailure') -or
                   ($code -eq 407) -or          # proxy auth / blocked
                   ($code -eq 451)              # unavailable for legal reasons
        return [pscustomobject]@{
            Url        = $Url
            Outcome    = $(if ($blocked) { 'BLOCKED' } else { 'REACHED' })
            StatusCode = $code
            Note       = "WebException: $status"
        }
    }
    catch {
        return [pscustomobject]@{
            Url        = $Url
            Outcome    = 'ERROR'
            StatusCode = 0
            Note       = $_.Exception.Message
        }
    }
}

$results = New-Object System.Collections.Generic.List[object]

Write-Host '=== Domains expected to be ALLOWED ===' -ForegroundColor Green
foreach ($d in $AllowedDomains) {
    $results.Add((Invoke-BlockedCheck -Url "https://$d$Path" -Timeout $TimeoutSec))
}

Write-Host "`n=== Domains expected to be BLOCKED ===' -ForegroundColor Yellow
foreach ($d in $BlockedDomains) {
    $results.Add((Invoke-BlockedCheck -Url "https://$d$Path" -Timeout $TimeoutSec))
}

Write-Host "`n================ RESULTS ================" -ForegroundColor Cyan
$results | Format-Table Url, Outcome, StatusCode, Note -AutoSize

# Pass/fail against expectations.
$failures = @()
foreach ($r in $results) {
    $host_ = ([System.Uri]::new($r.Url).Host)
    $expected = if ($AllowedDomains -contains $host_) { 'REACHED' }
                elseif ($BlockedDomains -contains $host_) { 'BLOCKED' }
                else { $null }
    if ($expected -and $r.Outcome -ne $expected) {
        $failures += "[$host_] expected=$expected got=$($r.Outcome)"
    }
}

if ($failures.Count -eq 0) {
    Write-Host "`nPASS: blocker behaved as configured." -ForegroundColor Green
    exit 0
} else {
    Write-Host "`nFAIL: mismatch(es):" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}
