param([string]$OutputPath = (Join-Path $env:LOCALAPPDATA 'QuotaCarry/testnet/approval-preview.html'))
$ErrorActionPreference = 'Stop'
# Historical Meteor checkpoint. The active deployment uses the CLI keychain.
$manifest = [pscustomobject]@{
    network = 'testnet'
    funding = 'nevanrg.testnet'
    contractFundingYocto = '2500000000000000000000000'
    roleFundingYocto = '50000000000000000000000'
}
$keysPath = Join-Path $env:LOCALAPPDATA 'QuotaCarry/testnet/child-public-keys.json'
$keys = @(Get-Content -Raw -LiteralPath $keysPath | ConvertFrom-Json)
$roles = @('contract', 'issuer', 'relayer', 'settler', 'alice', 'bob')
if ($manifest.network -cne 'testnet' -or $manifest.funding -cne 'nevanrg.testnet' -or
    $keys.Count -ne $roles.Count -or @($keys.publicKey | Sort-Object -Unique).Count -ne $roles.Count) {
    throw 'Unexpected deployment manifest or child key set'
}
$rows = foreach ($role in $roles) {
    $receiver = "$role.$($manifest.funding)"
    if ($receiver -cne "$role.nevanrg.testnet") { throw "Invalid receiver for $role" }
    $entry = @($keys | Where-Object { $_.accountId -ceq $receiver })
    if ($entry.Count -ne 1 -or $entry[0].publicKey -cnotmatch '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$') {
        throw "Invalid public key for $receiver"
    }
    $deposit = if ($role -eq 'contract') { '2.50' } else { '0.05' }
    $yocto = if ($role -eq 'contract') { $manifest.contractFundingYocto } else { $manifest.roleFundingYocto }
    $expected = if ($role -eq 'contract') { '2500000000000000000000000' } else { '50000000000000000000000' }
    if ($yocto -cne $expected) { throw "Funding changed for $receiver" }
    "<tr><td>$receiver</td><td>CreateAccount → Transfer → AddKey (FullAccess)</td><td>$deposit NEAR<br><code>$yocto yoctoNEAR</code></td><td><code>$($entry[0].publicKey)</code></td><td>Action fees only</td></tr>"
}
$html = @"
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QuotaCarry account creation review</title>
<style>
body { background:#f5f8f6;color:#142820;font:16px system-ui;margin:0; }
main { max-width:1100px;margin:auto;padding:3rem 1.5rem; }
table { border-collapse:collapse;background:white;width:100%; }
th,td { padding:1rem;text-align:left;border-bottom:1px solid #c6d7cd;vertical-align:top; }
code { overflow-wrap:anywhere; }
section { overflow:auto; }
</style>
<main>
<h1>Review QuotaCarry account creation</h1>
<p>Network <strong>NEAR testnet</strong> · Signer <strong>nevanrg.testnet</strong></p>
<p>Six separate transactions. Funding totals 2.75 NEAR. The checkpoint limit is 2.77 NEAR including fees.</p>
<p>This local preview has no wallet connection. Compare each row against the wallet approval screen once the signing integration is verified and authorized.</p>
<section aria-label="Account creation transactions">
<table>
<thead><tr><th scope="col">Receiver</th><th scope="col">Actions</th><th scope="col">Funding deposit</th><th scope="col">Child public key</th><th scope="col">Gas</th></tr></thead>
<tbody>$($rows -join [Environment]::NewLine)</tbody>
</table>
</section>
<p>These transactions contain no function calls and attach no prepaid function-call gas.</p>
</main>
</html>
"@
Set-Content -LiteralPath $OutputPath -Value $html -Encoding utf8
Get-Item -LiteralPath $OutputPath | Select-Object -ExpandProperty FullName
