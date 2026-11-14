use super::*;
use near_sdk::{NearToken, test_utils::VMContextBuilder, testing_env};

fn account(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}

fn context(name: &str, deposit: u128) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(account("quota"))
            .predecessor_account_id(account(name))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_height(100)
            .build()
    );
}

#[test]
fn metered_reservations_preserve_conservation_after_transfer() {
    context("quota", NearToken::from_near(1).as_yoctonear());
    let mut contract = QuotaPass::new(account("quota"));
    let issuer = contract.register_metered_issuer(
        account("issuer"),
        account("relay"),
        account("settler"),
        U128(500),
        4,
    );
    context("issuer", 0);
    let policy = contract.create_policy(issuer, "a".repeat(64), U128(500), 4);
    let nft = contract.issue(policy, account("alice"), U128(500), U64(0));
    context("relay", 0);
    contract.reserve_tokens(
        nft.clone(),
        account("alice"),
        U64(0),
        U64(0),
        "b".repeat(64),
        U64(110),
        U128(100),
    );
    assert_eq!(
        contract.get_token_reservation_maximum(nft.clone(), U64(0)),
        Some(U128(100))
    );
    context("alice", 1);
    contract.nft_transfer(account("bob"), nft.clone(), None, None);
    context("relay", 0);
    contract.reserve_tokens(
        nft.clone(),
        account("bob"),
        U64(1),
        U64(1),
        "c".repeat(64),
        U64(110),
        U128(200),
    );
    context("settler", 0);
    assert_eq!(
        contract.settle_tokens(nft.clone(), U64(0), U128(40)),
        SettlementResult::Applied
    );
    assert_eq!(
        contract.settle_tokens(nft.clone(), U64(0), U128(40)),
        SettlementResult::Duplicate
    );
    assert_eq!(
        contract.settle_tokens(nft.clone(), U64(0), U128(41)),
        SettlementResult::Conflict
    );
    assert_eq!(
        contract.settle_tokens(nft.clone(), U64(1), U128(0)),
        SettlementResult::Applied
    );
    let pass = contract.get_allowance(nft).unwrap();
    let totals = contract.get_policy(policy).unwrap();
    assert_eq!(pass.owner_id, account("bob"));
    assert_eq!(pass.open, 0);
    assert_eq!(pass.available.0, 460);
    assert_eq!(totals.consumed.0 + totals.available.0, totals.issued.0);
}

#[test]
fn randomized_conservation_and_storage_reuse() {
    context("quota", 0);
    let mut contract = QuotaPass::new(account("quota"));
    context("quota", NearToken::from_near(10).as_yoctonear());
    let issuer = contract.register_issuer(
        account("issuer"),
        account("relay"),
        account("settler"),
        U128(u128::MAX),
        50,
    );
    context("issuer", 0);
    let policy = contract.create_policy(issuer, "a".repeat(64), U128(u128::MAX), 50);
    let primary = contract.issue(policy, account("alice"), U128(u128::MAX - 1000), U64(0));
    let mut ids = vec![primary.clone()];
    let mut open = Vec::new();
    let mut seed = 5717u32;
    let mut owner = "alice";
    for _ in 0..280 {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let pass = contract.get_allowance(primary.clone()).unwrap();
        match seed % 7 {
            0 => {
                context("issuer", 0);
                let seq = contract.get_issuer(issuer).unwrap().next_issue_seq;
                ids.push(contract.issue(policy, account(owner), U128(1), seq));
            }
            1 => {
                context(owner, 1);
                owner = if owner == "alice" { "bob" } else { "alice" };
                contract.nft_transfer(account(owner), primary.clone(), None, None);
            }
            2 if ids.len() < 45 => {
                context(owner, 1);
                ids.push(contract.split(primary.clone(), U128(1), pass.epoch, pass.mutation_seq));
            }
            3 => {
                let source = ids.iter().skip(1).find_map(|id| {
                    let pass = contract.get_allowance(id.clone()).unwrap();
                    (pass.owner_id == account(owner)).then(|| (id.clone(), pass))
                });
                if let Some((id, source)) = source {
                    context(owner, 1);
                    contract.merge(
                        primary.clone(),
                        id.clone(),
                        pass.epoch,
                        source.epoch,
                        pass.mutation_seq,
                        source.mutation_seq,
                    );
                    ids.retain(|entry| entry != &id);
                }
            }
            4 if open.len() < OPEN_PER_PASS as usize => {
                context("relay", 0);
                contract.reserve(
                    primary.clone(),
                    account(owner),
                    pass.epoch,
                    pass.next_reservation_seq,
                    "b".repeat(64),
                    U64(110),
                );
                open.push(pass.next_reservation_seq);
            }
            5 | 6 => {
                if let Some(seq) = open.pop() {
                    context("settler", 0);
                    let disposition = if seed.is_multiple_of(2) {
                        Disposition::Consume
                    } else {
                        Disposition::Release
                    };
                    assert_eq!(
                        contract.settle(primary.clone(), seq, disposition),
                        SettlementResult::Applied
                    );
                    let repeat = contract.settle(primary.clone(), seq, disposition);
                    assert!(matches!(
                        repeat,
                        SettlementResult::Duplicate | SettlementResult::NoEvidence
                    ));
                }
            }
            _ => {}
        }
        let mut available = 0u128;
        let mut reserved = 0u128;
        for id in &ids {
            let pass = contract.get_allowance(id.clone()).unwrap();
            available = available.checked_add(pass.available.0).unwrap();
            reserved += u128::from(pass.open);
        }
        let ledger = contract.get_policy(policy).unwrap();
        assert_eq!(ledger.available.0, available);
        assert_eq!(u128::from(ledger.open), reserved);
        assert_eq!(ledger.issued.0, available + reserved + ledger.consumed.0);
        assert_eq!(contract.nft_total_supply().0, ids.len() as u128);
        assert_eq!(
            contract.get_issuer(issuer).unwrap().committed_bytes.0,
            ISSUER_BYTES + POLICY_BYTES + PASS_BYTES * ids.len() as u64
        );
    }
}

#[test]
fn release_during_pending_callback_preserves_credit_and_owner() {
    context("quota", 0);
    let mut contract = QuotaPass::new(account("quota"));
    context("quota", NearToken::from_near(1).as_yoctonear());
    let issuer = contract.register_issuer(
        account("issuer"),
        account("relay"),
        account("settler"),
        U128(100),
        4,
    );
    context("issuer", 0);
    let policy = contract.create_policy(issuer, "a".repeat(64), U128(100), 4);
    let token = contract.issue(policy, account("alice"), U128(100), U64(0));
    context("relay", 0);
    contract.reserve(
        token.clone(),
        account("alice"),
        U64(0),
        U64(0),
        "b".repeat(64),
        U64(110),
    );
    context("alice", 1);
    drop(contract.nft_transfer_call(
        account("bob"),
        token.clone(),
        None,
        None,
        "return".to_owned(),
    ));
    context("settler", 0);
    assert_eq!(
        contract.settle(token.clone(), U64(0), Disposition::Release),
        SettlementResult::Applied
    );
    let pass = contract.get_allowance(token).unwrap();
    assert_eq!(pass.owner_id, account("bob"));
    assert_eq!(pass.pending, 1);
    assert_eq!(pass.available.0, 100);
    assert_eq!(pass.open, 0);
}

#[test]
fn maximum_credit_balance_round_trips_through_reservation() {
    context("quota", 0);
    let mut contract = QuotaPass::new(account("quota"));
    context("quota", NearToken::from_near(1).as_yoctonear());
    let issuer = contract.register_issuer(
        account("issuer"),
        account("relay"),
        account("settler"),
        U128(u128::MAX),
        4,
    );
    context("issuer", 0);
    let policy = contract.create_policy(issuer, "a".repeat(64), U128(u128::MAX), 4);
    let token = contract.issue(policy, account("alice"), U128(u128::MAX), U64(0));
    context("relay", 0);
    contract.reserve(
        token.clone(),
        account("alice"),
        U64(0),
        U64(0),
        "b".repeat(64),
        U64(100),
    );
    context("settler", 0);
    assert_eq!(
        contract.settle(token.clone(), U64(0), Disposition::Release),
        SettlementResult::Applied
    );
    assert_eq!(
        contract.get_allowance(token).unwrap().available.0,
        u128::MAX
    );
    let policy = contract.get_policy(policy).unwrap();
    assert_eq!(policy.issued.0, u128::MAX);
    assert_eq!(policy.open, 0);
}
