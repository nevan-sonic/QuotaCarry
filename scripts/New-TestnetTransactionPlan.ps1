param(
    [Parameter(Mandatory)][ValidateSet('CreateAccounts','Deploy','RegisterIssuer','CreatePolicy','Mint','Reserve','Transfer','Settle')][string]$Operation,
    [string]$WasmPath,
    [string]$PolicyHash,
    [string]$Commitment,
    [uint64]$IssuerId,
    [uint64]$PolicyId,
    [uint64]$TokenId,
    [uint64]$Sequence,
    [uint64]$Epoch,
    [uint64]$ValidThroughHeight,
    [ValidateSet('Alice','Bob')][string]$Holder = 'Alice',
    [ValidateSet('consume','release')][string]$Disposition = 'consume'
)
$ErrorActionPreference = 'Stop'
$m = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../infra/testnet-deployment.json') | ConvertFrom-Json
if ($m.network -cne 'testnet' -or $m.funding -cne 'quotacarry-fund-7b29e1.testnet' -or $m.governance -cne $m.funding -or $m.contract -cne $m.funding -or
    $m.initialize.args.governance -cne $m.governance) { throw 'Unexpected network or governance' }
foreach ($role in 'issuer','relayer','settler','alice','bob') {
    if ($m.$role -cne "$role.$($m.funding)") { throw "Unexpected $role account" }
}

function New-Call($Signer, $Method, $Arguments, $Gas = 30, $Deposit = '0') {
    [ordered]@{
        network = 'testnet'; signer = $Signer; receiver = $m.contract
        method = $Method; args = $Arguments; gasTgas = $Gas; depositYocto = $Deposit
    }
}

$result = switch ($Operation) {
    'CreateAccounts' {
        foreach ($role in 'issuer','relayer','settler','alice','bob') {
            $amount = $m.roleFundingYocto
            if (!$m.childPublicKeys.PSObject.Properties[$m.$role]) { throw "Missing approved key for $role" }
            [ordered]@{network='testnet'; signer=$m.funding; newAccount=$m.$role; transferYocto=$amount; key=$m.childPublicKeys.PSObject.Properties[$m.$role].Value}
        }
    }
    'Deploy' {
        if (!$WasmPath) { throw 'Supply the reviewed WASM path' }
        $file = Get-Item -LiteralPath $WasmPath
        if ($file.Length -ne $m.wasmBytes -or (Get-FileHash -LiteralPath $file.FullName).Hash -ine $m.wasmSha256) {
            throw 'Artifact mismatch'
        }
        $tx = New-Call $m.contract $m.initialize.method $m.initialize.args $m.initialize.gasTgas $m.initialize.depositYocto
        $tx['deployFile'] = $file.FullName
        $tx['deploySha256'] = $m.wasmSha256
        $tx
    }
    'RegisterIssuer' {
        New-Call $m.governance 'register_issuer' @{
            controller=$m.issuer; authorizer=$m.relayer; settler=$m.settler; lifetime_cap='100'; max_open=4
        } 30 $m.issuerDepositYocto
    }
    'CreatePolicy' {
        if ($PolicyHash -cnotmatch '^[a-f0-9]{64}$') { throw 'Supply the reviewed lowercase SHA-256 policy hash' }
        New-Call $m.issuer 'create_policy' @{issuer_id="$IssuerId";policy_hash=$PolicyHash;lifetime_cap='100';max_open=4}
    }
    'Mint' {
        New-Call $m.issuer 'issue' @{policy_id="$PolicyId";receiver_id=$m.alice;amount='100';expected_issue_seq="$Sequence"}
    }
    'Reserve' {
        if ($Commitment -cnotmatch '^[a-f0-9]{64}$' -or !$ValidThroughHeight) { throw 'Supply a commitment and finalized-height-derived deadline' }
        New-Call $m.relayer 'reserve' @{
            token_id="$TokenId";holder_id=$m.($Holder.ToLowerInvariant());expected_epoch="$Epoch";seq="$Sequence"
            request_commitment=$Commitment;valid_through_height="$ValidThroughHeight"
        }
    }
    'Transfer' {
        New-Call $m.alice 'nft_transfer' @{receiver_id=$m.bob;token_id="$TokenId"} 30 '1'
    }
    'Settle' {
        New-Call $m.settler 'settle' @{token_id="$TokenId";seq="$Sequence";disposition=$Disposition}
    }
}
ConvertTo-Json -InputObject $result -Depth 8
