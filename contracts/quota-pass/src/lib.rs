mod model;
mod nft;
#[cfg(test)]
mod tests;

pub use model::{Disposition, Issuer, Pass, Policy, Reservation, SettlementResult};
use model::{PendingTransfer, Settlement};
use near_sdk::{
    AccountId, BorshStorageKey, PanicOnDefault, assert_one_yocto,
    borsh::BorshSerialize,
    collections::{LookupMap, UnorderedSet},
    env,
    json_types::{U64, U128},
    near, require,
    serde_json::{Value, json},
};

const ISSUER_BYTES: u64 = 768;
const POLICY_BYTES: u64 = 512;
const PASS_BYTES: u64 = 4096;
const CALLBACK_BYTES: u64 = 512;
const OPEN_PER_PASS: u32 = 4;
const SETTLEMENT_WINDOW: u64 = 8;
const MAX_DEADLINE_DISTANCE: u64 = 120;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Issuers,
    Policies,
    Passes,
    Tokens,
    OwnerTokens,
    OwnerSet([u8; 32]),
    Reservations,
    Settlements,
    Pending,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct QuotaPass {
    state_version: u16,
    governance: AccountId,
    paused: bool,
    next_issuer: u64,
    next_policy: u64,
    next_token: u64,
    next_transfer: u64,
    issuers: LookupMap<u64, Issuer>,
    policies: LookupMap<u64, Policy>,
    passes: LookupMap<String, Pass>,
    tokens: UnorderedSet<String>,
    owner_tokens: LookupMap<AccountId, UnorderedSet<String>>,
    reservations: LookupMap<(String, u64), Reservation>,
    settlements: LookupMap<(String, u64), Settlement>,
    pending: LookupMap<(String, u64), PendingTransfer>,
}

#[near]
impl QuotaPass {
    #[init]
    pub fn new(governance: AccountId) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Initialize from contract account"
        );
        Self {
            state_version: 1,
            governance,
            paused: false,
            next_issuer: 0,
            next_policy: 0,
            next_token: 0,
            next_transfer: 0,
            issuers: LookupMap::new(Key::Issuers),
            policies: LookupMap::new(Key::Policies),
            passes: LookupMap::new(Key::Passes),
            tokens: UnorderedSet::new(Key::Tokens),
            owner_tokens: LookupMap::new(Key::OwnerTokens),
            reservations: LookupMap::new(Key::Reservations),
            settlements: LookupMap::new(Key::Settlements),
            pending: LookupMap::new(Key::Pending),
        }
    }

    #[payable]
    pub fn register_issuer(
        &mut self,
        controller: AccountId,
        authorizer: AccountId,
        settler: AccountId,
        lifetime_cap: U128,
        max_open: u32,
    ) -> U64 {
        self.assert_governance();
        assert_roles(&controller, &authorizer, &settler);
        require!(lifetime_cap.0 > 0 && max_open > 0, "Invalid issuer limits");
        let start = env::storage_usage();
        let id = take_id(&mut self.next_issuer);
        let mut issuer = Issuer {
            controller,
            authorizer,
            settler,
            lifetime_cap,
            max_open,
            funded: U128(env::attached_deposit().as_yoctonear()),
            committed_bytes: U64(0),
            issued: U128(0),
            open: 0,
            paused: false,
            next_issue_seq: U64(0),
        };
        commit_storage(&mut issuer, ISSUER_BYTES);
        self.issuers.insert(&id, &issuer);
        assert_growth(start, ISSUER_BYTES);
        event(
            "issuer_registered",
            json!({"issuer_id": U64(id), "issuer": issuer}),
        );
        U64(id)
    }

    #[payable]
    pub fn fund_storage(&mut self, issuer_id: U64) -> U128 {
        let mut issuer = self.controller(issuer_id);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Zero funding");
        issuer.funded.0 = add(issuer.funded.0, amount);
        self.issuers.insert(&issuer_id.0, &issuer);
        event(
            "storage_funded",
            json!({"issuer_id": issuer_id, "amount": U128(amount)}),
        );
        issuer.funded
    }

    pub fn rotate_roles(
        &mut self,
        issuer_id: U64,
        controller: AccountId,
        authorizer: AccountId,
        settler: AccountId,
    ) {
        let mut issuer = self.controller(issuer_id);
        assert_roles(&controller, &authorizer, &settler);
        let start = env::storage_usage();
        issuer.controller = controller;
        issuer.authorizer = authorizer;
        issuer.settler = settler;
        self.issuers.insert(&issuer_id.0, &issuer);
        assert_growth(start, 192);
        event(
            "roles_rotated",
            json!({"issuer_id": issuer_id, "controller": issuer.controller, "authorizer": issuer.authorizer, "settler": issuer.settler}),
        );
    }

    pub fn set_emergency_pause(&mut self, paused: bool) {
        self.assert_governance();
        self.paused = paused;
        event("emergency_pause", json!({"paused": paused}));
    }

    pub fn set_issuer_pause(&mut self, issuer_id: U64, paused: bool) {
        let mut issuer = self.controller(issuer_id);
        issuer.paused = paused;
        self.issuers.insert(&issuer_id.0, &issuer);
        event(
            "issuer_pause",
            json!({"issuer_id": issuer_id, "paused": paused}),
        );
    }

    pub fn set_policy_suspension(&mut self, policy_id: U64, suspended: bool) {
        let mut policy = self.policy(policy_id);
        self.controller(policy.issuer_id);
        policy.suspended = suspended;
        self.policies.insert(&policy_id.0, &policy);
        event(
            "policy_suspension",
            json!({"policy_id": policy_id, "suspended": suspended}),
        );
    }

    pub fn create_policy(
        &mut self,
        issuer_id: U64,
        policy_hash: String,
        lifetime_cap: U128,
        max_open: u32,
    ) -> U64 {
        let mut issuer = self.controller(issuer_id);
        assert_digest(&policy_hash);
        require!(
            lifetime_cap.0 > 0 && lifetime_cap.0 <= issuer.lifetime_cap.0,
            "Invalid policy lifetime cap"
        );
        require!(
            max_open > 0 && max_open <= issuer.max_open,
            "Invalid policy open cap"
        );
        let start = env::storage_usage();
        let id = take_id(&mut self.next_policy);
        commit_storage(&mut issuer, POLICY_BYTES);
        self.policies.insert(
            &id,
            &Policy {
                issuer_id,
                policy_hash: policy_hash.clone(),
                denomination_version: 1,
                lifetime_cap,
                issued: U128(0),
                available: U128(0),
                consumed: U128(0),
                max_open,
                open: 0,
                suspended: false,
            },
        );
        self.issuers.insert(&issuer_id.0, &issuer);
        assert_growth(start, POLICY_BYTES);
        event(
            "policy_created",
            json!({"issuer_id": issuer_id, "policy_id": U64(id), "policy_hash": policy_hash}),
        );
        U64(id)
    }

    pub fn issue(
        &mut self,
        policy_id: U64,
        receiver_id: AccountId,
        amount: U128,
        expected_issue_seq: U64,
    ) -> String {
        let mut policy = self.policy(policy_id);
        let mut issuer = self.controller(policy.issuer_id);
        self.assert_active(&issuer, &policy);
        require!(
            amount.0 > 0 && issuer.next_issue_seq == expected_issue_seq,
            "Invalid issuance amount or sequence"
        );
        issuer.issued.0 = add(issuer.issued.0, amount.0);
        policy.issued.0 = add(policy.issued.0, amount.0);
        require!(
            issuer.issued.0 <= issuer.lifetime_cap.0 && policy.issued.0 <= policy.lifetime_cap.0,
            "Lifetime cap exceeded"
        );
        issuer.next_issue_seq.0 = increment(issuer.next_issue_seq.0);
        policy.available.0 = add(policy.available.0, amount.0);
        let id = self.mint_pass(
            &mut issuer,
            receiver_id,
            policy.issuer_id,
            policy_id,
            amount,
        );
        self.issuers.insert(&policy.issuer_id.0, &issuer);
        self.policies.insert(&policy_id.0, &policy);
        event(
            "issue",
            json!({"token_id": id, "policy_id": policy_id, "amount": amount}),
        );
        id
    }

    #[payable]
    pub fn split(
        &mut self,
        token_id: String,
        amount: U128,
        expected_epoch: U64,
        expected_mutation_seq: U64,
    ) -> String {
        assert_one_yocto();
        let mut parent = self.owned_pass(&token_id, expected_epoch, expected_mutation_seq);
        require!(
            amount.0 > 0 && amount.0 < parent.available.0,
            "Invalid split amount"
        );
        let mut issuer = self.issuer(parent.issuer_id);
        parent.available.0 = subtract(parent.available.0, amount.0);
        parent.mutation_seq.0 = increment(parent.mutation_seq.0);
        let child = self.mint_pass(
            &mut issuer,
            parent.owner_id.clone(),
            parent.issuer_id,
            parent.policy_id,
            amount,
        );
        self.passes.insert(&token_id, &parent);
        self.issuers.insert(&parent.issuer_id.0, &issuer);
        event(
            "split",
            json!({"token_id": token_id, "child_id": child, "amount": amount}),
        );
        child
    }

    #[payable]
    pub fn merge(
        &mut self,
        target_id: String,
        source_id: String,
        target_epoch: U64,
        source_epoch: U64,
        target_mutation_seq: U64,
        source_mutation_seq: U64,
    ) {
        assert_one_yocto();
        require!(target_id != source_id, "Merge requires distinct tokens");
        let mut target = self.owned_pass(&target_id, target_epoch, target_mutation_seq);
        let source = self.owned_pass(&source_id, source_epoch, source_mutation_seq);
        require!(
            target.policy_id == source.policy_id && target.issuer_id == source.issuer_id,
            "Incompatible passes"
        );
        require!(source.open == 0, "Source has reservations");
        let mut issuer = self.issuer(source.issuer_id);
        target.available.0 = add(target.available.0, source.available.0);
        target.mutation_seq.0 = increment(target.mutation_seq.0);
        self.passes.insert(&target_id, &target);
        self.burn_pass(&source_id, &source.owner_id);
        release_storage(&mut issuer, PASS_BYTES);
        self.issuers.insert(&source.issuer_id.0, &issuer);
        event(
            "merge",
            json!({"token_id": target_id, "source_id": source_id, "amount": source.available}),
        );
    }

    pub fn reserve(
        &mut self,
        token_id: String,
        holder_id: AccountId,
        expected_epoch: U64,
        seq: U64,
        request_commitment: String,
        valid_through_height: U64,
    ) {
        assert_digest(&request_commitment);
        let height = env::block_height();
        require!(
            valid_through_height
                .0
                .checked_sub(height)
                .is_some_and(|distance| distance <= MAX_DEADLINE_DISTANCE),
            "Invalid reservation deadline"
        );
        let mut pass = self.pass(&token_id);
        let mut policy = self.policy(pass.policy_id);
        let mut issuer = self.issuer(pass.issuer_id);
        require!(
            env::predecessor_account_id() == issuer.authorizer,
            "Authorizer required"
        );
        commit_storage(&mut issuer, 0);
        self.assert_active(&issuer, &policy);
        require!(
            pass.owner_id == holder_id && pass.epoch == expected_epoch,
            "Stale ownership"
        );
        require!(pass.pending == 0, "Transfer unresolved");
        require!(
            pass.next_reservation_seq == seq && pass.available.0 > 0,
            "Invalid sequence or exhausted pass"
        );
        require!(
            pass.open < OPEN_PER_PASS
                && issuer.open < issuer.max_open
                && policy.open < policy.max_open,
            "Open limit reached"
        );
        let start = env::storage_usage();
        pass.next_reservation_seq.0 = increment(seq.0);
        pass.available.0 = subtract(pass.available.0, 1);
        policy.available.0 = subtract(policy.available.0, 1);
        pass.open = open_increment(pass.open);
        issuer.open = open_increment(issuer.open);
        policy.open = open_increment(policy.open);
        self.reservations.insert(
            &(token_id.clone(), seq.0),
            &Reservation {
                holder_id,
                epoch: expected_epoch,
                commitment: request_commitment.clone(),
                valid_through_height,
            },
        );
        self.passes.insert(&token_id, &pass);
        self.policies.insert(&pass.policy_id.0, &policy);
        self.issuers.insert(&pass.issuer_id.0, &issuer);
        assert_growth(start, 256);
        event(
            "reserve",
            json!({"token_id": token_id, "seq": seq, "epoch": expected_epoch, "commitment": request_commitment, "policy_id": pass.policy_id, "amount": U128(1)}),
        );
    }

    pub fn settle(
        &mut self,
        token_id: String,
        seq: U64,
        disposition: Disposition,
    ) -> SettlementResult {
        assert_token_id(&token_id);
        let Some(mut pass) = self.passes.get(&token_id) else {
            return SettlementResult::NoEvidence;
        };
        let mut issuer = self.issuer(pass.issuer_id);
        require!(
            env::predecessor_account_id() == issuer.settler,
            "Settler required"
        );
        let slot = (token_id.clone(), seq.0 % SETTLEMENT_WINDOW);
        if self.reservations.get(&(token_id.clone(), seq.0)).is_none() {
            return match self.settlements.get(&slot) {
                Some(entry) if entry.seq == seq && entry.disposition == disposition => {
                    SettlementResult::Duplicate
                }
                Some(entry) if entry.seq == seq => SettlementResult::Conflict,
                _ => SettlementResult::NoEvidence,
            };
        }
        let mut policy = self.policy(pass.policy_id);
        pass.open = open_decrement(pass.open);
        issuer.open = open_decrement(issuer.open);
        policy.open = open_decrement(policy.open);
        let event_name = match disposition {
            Disposition::Consume => {
                policy.consumed.0 = add(policy.consumed.0, 1);
                "consume"
            }
            Disposition::Release => {
                pass.available.0 = add(pass.available.0, 1);
                policy.available.0 = add(policy.available.0, 1);
                "release"
            }
        };
        self.reservations.remove(&(token_id.clone(), seq.0));
        if self
            .settlements
            .get(&slot)
            .is_none_or(|entry| entry.seq.0 < seq.0)
        {
            self.settlements
                .insert(&slot, &Settlement { seq, disposition });
        }
        self.passes.insert(&token_id, &pass);
        self.policies.insert(&pass.policy_id.0, &policy);
        self.issuers.insert(&pass.issuer_id.0, &issuer);
        event(
            event_name,
            json!({"token_id": token_id, "seq": seq, "policy_id": pass.policy_id, "amount": U128(1)}),
        );
        SettlementResult::Applied
    }

    pub fn get_allowance(&self, token_id: String) -> Option<Pass> {
        assert_token_id(&token_id);
        self.passes.get(&token_id)
    }

    pub fn get_reservation(&self, token_id: String, seq: U64) -> Option<Reservation> {
        assert_token_id(&token_id);
        self.reservations.get(&(token_id, seq.0))
    }

    pub fn get_issuer(&self, issuer_id: U64) -> Option<Issuer> {
        self.issuers.get(&issuer_id.0)
    }

    pub fn get_policy(&self, policy_id: U64) -> Option<Policy> {
        self.policies.get(&policy_id.0)
    }

    pub fn is_emergency_paused(&self) -> bool {
        self.paused
    }
}

impl QuotaPass {
    fn assert_governance(&self) {
        require!(
            env::predecessor_account_id() == self.governance,
            "Governance required"
        );
    }

    fn issuer(&self, id: U64) -> Issuer {
        self.get_issuer(id)
            .unwrap_or_else(|| env::panic_str("Unknown issuer"))
    }

    fn controller(&self, id: U64) -> Issuer {
        let issuer = self.issuer(id);
        require!(
            env::predecessor_account_id() == issuer.controller,
            "Issuer controller required"
        );
        issuer
    }

    fn policy(&self, id: U64) -> Policy {
        self.get_policy(id)
            .unwrap_or_else(|| env::panic_str("Unknown policy"))
    }

    fn assert_active(&self, issuer: &Issuer, policy: &Policy) {
        require!(
            !self.paused && !issuer.paused && !policy.suspended,
            "Issuance and reservations suspended"
        );
    }

    fn pass(&self, id: &String) -> Pass {
        assert_token_id(id);
        self.passes
            .get(id)
            .unwrap_or_else(|| env::panic_str("Unknown token"))
    }

    fn owned_pass(&self, id: &String, epoch: U64, mutation: U64) -> Pass {
        let pass = self.pass(id);
        require!(
            env::predecessor_account_id() == pass.owner_id,
            "Owner required"
        );
        require!(
            pass.epoch == epoch && pass.mutation_seq == mutation,
            "Stale mutation"
        );
        require!(pass.pending == 0, "Transfer unresolved");
        pass
    }
}

fn assert_roles(controller: &AccountId, authorizer: &AccountId, settler: &AccountId) {
    require!(
        controller != authorizer && controller != settler && authorizer != settler,
        "Roles must be distinct"
    );
}

fn assert_digest(value: &str) {
    require!(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Expected 32-byte lowercase hex digest"
    );
}

fn assert_token_id(id: &str) {
    require!(
        !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()),
        "Invalid token ID"
    );
}

fn event(name: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "quotacarry", "version": "1.0.0", "event": name, "data": [data]})
    ));
}

fn increment(value: u64) -> u64 {
    value
        .checked_add(1)
        .unwrap_or_else(|| env::panic_str("Counter overflow"))
}

fn take_id(next: &mut u64) -> u64 {
    let id = *next;
    *next = increment(id);
    id
}

fn open_increment(value: u32) -> u32 {
    value
        .checked_add(1)
        .unwrap_or_else(|| env::panic_str("Open count overflow"))
}

fn open_decrement(value: u32) -> u32 {
    value
        .checked_sub(1)
        .unwrap_or_else(|| env::panic_str("Open count underflow"))
}

fn add(left: u128, right: u128) -> u128 {
    left.checked_add(right)
        .unwrap_or_else(|| env::panic_str("Credit or funding overflow"))
}

fn subtract(left: u128, right: u128) -> u128 {
    left.checked_sub(right)
        .unwrap_or_else(|| env::panic_str("Credit underflow"))
}

fn commit_storage(issuer: &mut Issuer, bytes: u64) {
    let total = issuer
        .committed_bytes
        .0
        .checked_add(bytes)
        .unwrap_or_else(|| env::panic_str("Storage counter overflow"));
    let cost = u128::from(total)
        .checked_mul(env::storage_byte_cost().as_yoctonear())
        .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
    require!(cost <= issuer.funded.0, "Insufficient prepaid storage");
    issuer.committed_bytes = U64(total);
}

fn release_storage(issuer: &mut Issuer, bytes: u64) {
    issuer.committed_bytes.0 = issuer
        .committed_bytes
        .0
        .checked_sub(bytes)
        .unwrap_or_else(|| env::panic_str("Storage counter underflow"));
}

fn assert_growth(start: u64, bound: u64) {
    require!(
        env::storage_usage().saturating_sub(start) <= bound,
        "Storage bound exceeded"
    );
}
