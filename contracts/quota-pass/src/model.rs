use near_sdk::{
    AccountId,
    json_types::{U64, U128},
    near,
};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Issuer {
    pub controller: AccountId,
    pub authorizer: AccountId,
    pub settler: AccountId,
    pub paused: bool,
    pub funded: U128,
    pub committed_bytes: U64,
    pub lifetime_cap: U128,
    pub issued: U128,
    pub max_open: u32,
    pub open: u32,
    pub next_issue_seq: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    pub issuer_id: U64,
    pub policy_hash: String,
    pub denomination_version: u16,
    pub lifetime_cap: U128,
    pub issued: U128,
    pub consumed: U128,
    pub available: U128,
    pub max_open: u32,
    pub open: u32,
    pub suspended: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pass {
    pub owner_id: AccountId,
    pub issuer_id: U64,
    pub policy_id: U64,
    pub available: U128,
    pub open: u32,
    pub epoch: U64,
    pub next_reservation_seq: U64,
    pub mutation_seq: U64,
    pub pending: u32,
}

#[near(serializers = [borsh, json])]
pub struct Reservation {
    pub holder_id: AccountId,
    pub epoch: U64,
    pub commitment: String,
    pub valid_through_height: U64,
}

#[near(serializers = [borsh])]
pub(crate) struct PendingTransfer {
    pub previous_owner: AccountId,
    pub receiver: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Consume,
    Release,
}

#[near(serializers = [borsh])]
pub(crate) struct Settlement {
    pub seq: U64,
    pub disposition: Disposition,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SettlementResult {
    Applied,
    Duplicate,
    Conflict,
    NoEvidence,
}
