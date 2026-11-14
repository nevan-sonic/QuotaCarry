param(
    [Parameter(Mandatory)][string]$WasmPath
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../infra/testnet-deployment.json') | ConvertFrom-Json
if ($manifest.network -cne 'testnet') { throw 'Only NEAR testnet is supported' }
$expectedRoles = [ordered]@{
    issuer = 'issuer'; relayer = 'relayer'
    settler = 'settler'; alice = 'alice'; bob = 'bob'
}
if ($manifest.funding -cne 'quotacarry-fund-7b29e1.testnet' -or $manifest.governance -cne $manifest.funding -or $manifest.contract -cne $manifest.funding -or
    $manifest.initialize.args.governance -cne $manifest.governance) { throw 'Unexpected funding or governance identity' }
foreach ($role in $expectedRoles.Keys) {
    if ($manifest.$role -cne "$($expectedRoles[$role]).$($manifest.funding)") {
        throw "Unexpected testnet account for $role"
    }
}
$wasm = Get-Item -LiteralPath $WasmPath
if ($wasm.Length -ne $manifest.wasmBytes -or
    (Get-FileHash -LiteralPath $wasm.FullName -Algorithm SHA256).Hash -ine $manifest.wasmSha256) {
    throw 'Artifact does not match the manifest'
}

function Invoke-NearRead([string]$Method, $Params) {
    Invoke-RestMethod -Uri 'https://rpc.testnet.near.org' -Method Post -ContentType 'application/json' -TimeoutSec 20 -Body (
        @{jsonrpc='2.0'; id='quotacarry'; method=$Method; params=$Params} | ConvertTo-Json -Depth 8 -Compress
    )
}

$nodeStatus = Invoke-NearRead 'status' @()
if ($nodeStatus.result.chain_id -cne 'testnet') { throw 'Unexpected RPC network' }
$block = (Invoke-NearRead 'block' @{finality='final'}).result.header
if (!$block.hash) { throw 'Finalized block unavailable' }
$parent = Invoke-NearRead 'query' @{request_type='view_account'; block_id=$block.hash; account_id=$manifest.funding}
if (!$parent.result) { throw 'Funding account unavailable' }
if ($parent.result.code_hash -cne '11111111111111111111111111111111') { throw 'Contract account already has code' }
$protocol = (Invoke-NearRead 'EXPERIMENTAL_protocol_config' @{block_id=$block.hash}).result
if (!$protocol.runtime_config.storage_amount_per_byte) { throw 'Missing storage price' }
$price = [bigint]$protocol.runtime_config.storage_amount_per_byte
$available = [bigint]$parent.result.amount - [bigint]$parent.result.storage_usage * $price
foreach ($role in $expectedRoles.Keys) {
    $accountId = $manifest.$role
    $reply = Invoke-NearRead 'query' @{request_type='view_account'; block_id=$block.hash; account_id=$accountId}
    if ($reply.result) { throw "Account already exists and requires separate review: $accountId" }
    if ($reply.error.cause.name -cne 'UNKNOWN_ACCOUNT') { throw "Could not verify availability: $accountId" }
    Write-Output "$role $accountId available"
}
$codeStake = [bigint]$wasm.Length * $price
$required = [bigint]$manifest.contractFundingYocto + 5 * [bigint]$manifest.roleFundingYocto +
    [bigint]$manifest.issuerDepositYocto + [bigint]$manifest.feeReserveYocto
if ([bigint]$manifest.contractFundingYocto -lt ($codeStake + 4096 * $price) -or
    $required -gt [bigint]$manifest.fundingFloorYocto) { throw 'Storage price or manifest budget needs review' }
[pscustomobject]@{
    network = $manifest.network; block = $block.hash; funding = $manifest.funding
    balanceYocto = $parent.result.amount; spendableYocto = "$available"
    codeStakeYocto = "$codeStake"; fundingFloorYocto = $manifest.fundingFloorYocto
} | ConvertTo-Json
if ($available -lt [bigint]$manifest.fundingFloorYocto) {
    throw 'Insufficient spendable funding for the proposed manifest'
}
Write-Output 'Read-only checks passed. Signing remains subject to explicit approval.'
