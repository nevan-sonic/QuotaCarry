import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const endpoint = 'https://rpc.testnet.near.org';
const contract = process.env.QUOTACARRY_CONTRACT_ID;

async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'quotacarry', method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const reply = await response.json();
  if (reply.error || !reply.result) throw new Error(`RPC ${method}: ${reply.error?.cause?.name ?? reply.error?.message ?? 'missing result'}`);
  return reply.result;
}

function requireMatch(condition, message) {
  if (!condition) throw new Error(message);
}

function uint(value, label) {
  requireMatch(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), `Invalid ${label}`);
  return BigInt(value);
}

async function main() {
  requireMatch(contract && /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.testnet$/.test(contract), 'Set QUOTACARRY_CONTRACT_ID to a named .testnet account');
  requireMatch(process.argv.length === 3, 'Usage: node scripts/verify-testnet.mjs <expectations.json>');
  const expected = JSON.parse(await readFile(process.argv[2], 'utf8'));
  for (const field of ['policyId', 'issuerId', 'tokenId', 'epoch', 'available']) uint(expected[field], field);
  requireMatch(typeof expected.owner === 'string' && Number.isSafeInteger(expected.open) && expected.open >= 0, 'Expected owner and numeric open count required');
  requireMatch(/^[a-f0-9]{64}$/.test(expected.wasmSha256 ?? ''), 'Expected WASM SHA-256 required');
  requireMatch(Array.isArray(expected.transactions) && expected.transactions.length > 0, 'Supply observed transaction references');

  const block = (await rpc('block', { finality: 'final' })).header;
  const query = (request_type, params) => rpc('query', {
    request_type, block_id: block.hash, account_id: contract, ...params,
  });
  const view = async (method_name, args) => {
    const result = await query('call_function', {
      method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
  };

  const code = await query('view_code', {});
  const hash = createHash('sha256').update(Buffer.from(code.code_base64, 'base64')).digest('hex');
  requireMatch(hash === expected.wasmSha256, 'On-chain WASM hash mismatch');
  const [policy, issuer, pass, nft, supply] = await Promise.all([
    view('get_policy', { policy_id: expected.policyId }),
    view('get_issuer', { issuer_id: expected.issuerId }),
    view('get_allowance', { token_id: expected.tokenId }),
    view('nft_token', { token_id: expected.tokenId }),
    view('nft_total_supply', {}),
  ]);
  requireMatch(policy?.issuer_id === expected.issuerId && issuer, 'Issuer/policy mismatch');
  for (const [field, value] of Object.entries(expected.roles ?? {})) {
    requireMatch(['controller', 'authorizer', 'settler'].includes(field) && issuer[field] === value, `Issuer role mismatch: ${field}`);
  }
  requireMatch(nft?.owner_id === expected.owner && pass?.owner_id === expected.owner, 'Owner mismatch');
  requireMatch(pass.epoch === expected.epoch && pass.available === expected.available && pass.open === expected.open, 'Epoch or allowance mismatch');
  requireMatch(pass.policy_id === expected.policyId && pass.issuer_id === expected.issuerId, 'Pass policy mismatch');

  let available = 0n;
  let open = 0n;
  const seen = new Set();
  const total = uint(supply, 'total supply');
  for (let offset = 0n; offset < total; offset += 50n) {
    const page = await view('nft_tokens', { from_index: String(offset), limit: 50 });
    requireMatch(Array.isArray(page) && page.length === Number(total - offset > 50n ? 50n : total - offset), 'Incomplete NFT enumeration');
    const allowances = await Promise.all(page.map(({ token_id }) => view('get_allowance', { token_id })));
    for (const [index, allowance] of allowances.entries()) {
      const { token_id, owner_id } = page[index];
      requireMatch(!seen.has(token_id) && allowance?.owner_id === owner_id, 'Enumeration disagrees with allowance');
      seen.add(token_id);
      if (allowance.policy_id === expected.policyId) {
        requireMatch(Number.isSafeInteger(allowance.open) && allowance.open >= 0, 'Invalid open liability count');
        available += uint(allowance.available, 'allowance');
        open += BigInt(allowance.open);
      }
    }
  }
  const issued = uint(policy.issued, 'issued');
  const consumed = uint(policy.consumed, 'consumed');
  requireMatch(available === uint(policy.available, 'policy available') && open === BigInt(policy.open)
    && issued === available + open + consumed, 'Conservation failure');

  for (const ref of expected.transactions) {
    requireMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ref.hash ?? '') && typeof ref.signer === 'string'
      && typeof ref.method === 'string' && typeof ref.success === 'boolean', 'Invalid transaction reference');
    const tx = await rpc('tx', { tx_hash: ref.hash, sender_account_id: ref.signer, wait_until: 'FINAL' });
    requireMatch(tx.final_execution_status === 'FINAL' && tx.transaction.hash === ref.hash
      && tx.transaction.signer_id === ref.signer && tx.transaction.receiver_id === contract, 'Transaction identity or finality mismatch');
    requireMatch(tx.transaction.actions.some(action => action.FunctionCall?.method_name === ref.method), 'Transaction method mismatch');
    const receipts = tx.receipts_outcome.filter(receipt => receipt.outcome.executor_id === contract);
    requireMatch(receipts.length > 0, 'Missing contract execution receipt');
    const success = Object.hasOwn(tx.status, 'SuccessValue');
    requireMatch(ref.success ? success && receipts.every(r => !Object.hasOwn(r.outcome.status, 'Failure'))
      : Object.hasOwn(tx.status, 'Failure') && receipts.some(r => Object.hasOwn(r.outcome.status, 'Failure')), 'Unexpected transaction outcome');
    if (Object.hasOwn(ref, 'returnValue')) {
      requireMatch(success, 'Expected a successful return value');
      const raw = Buffer.from(tx.status.SuccessValue, 'base64').toString('utf8');
      requireMatch(JSON.stringify(raw ? JSON.parse(raw) : null) === JSON.stringify(ref.returnValue), 'Unexpected contract return value');
    }
    console.log(JSON.stringify({ hash: ref.hash, method: ref.method, success,
      receipts: receipts.map(r => ({ id: r.id, status: r.outcome.status, gas: r.outcome.gas_burnt })),
      explorer: `https://testnet.nearblocks.io/txns/${ref.hash}` }));
  }
  console.log(JSON.stringify({ contract, block: block.hash, hash, owner: expected.owner, epoch: pass.epoch,
    issued: String(issued), available: String(available), open: String(open), consumed: String(consumed) }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
