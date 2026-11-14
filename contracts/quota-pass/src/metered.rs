use super::*;

#[near]
impl QuotaPass {
    #[payable]
    pub fn register_metered_issuer(
        &mut self,
        controller: AccountId,
        authorizer: AccountId,
        settler: AccountId,
        lifetime_cap: U128,
        max_open: u32,
    ) -> U64 {
        let start = env::storage_usage();
        let id = self.register_issuer(controller, authorizer, settler, lifetime_cap, max_open);
        self.metered_issuers().insert(&id.0, &true);
        assert_growth(start, ISSUER_BYTES);
        id
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reserve_tokens(
        &mut self,
        token_id: String,
        holder_id: AccountId,
        expected_epoch: U64,
        seq: U64,
        request_commitment: String,
        valid_through_height: U64,
        maximum: U128,
    ) {
        self.reserve_units(
            token_id,
            holder_id,
            expected_epoch,
            seq,
            request_commitment,
            valid_through_height,
            Some(maximum),
        );
    }

    pub fn get_token_reservation_maximum(&self, token_id: String, seq: U64) -> Option<U128> {
        assert_token_id(&token_id);
        self.metered_amounts().get(&(token_id, seq.0)).map(U128)
    }

    pub fn settle_tokens(&mut self, token_id: String, seq: U64, actual: U128) -> SettlementResult {
        assert_token_id(&token_id);
        let Some(mut pass) = self.passes.get(&token_id) else {
            return SettlementResult::NoEvidence;
        };
        let mut policy = self.policy(pass.policy_id);
        require!(policy.denomination_version == 2, "Wrong denomination");
        let mut issuer = self.issuer(pass.issuer_id);
        require!(
            env::predecessor_account_id() == issuer.settler,
            "Settler required"
        );
        let key = (token_id.clone(), seq.0);
        let slot = (token_id.clone(), seq.0 % SETTLEMENT_WINDOW);
        let mut history = self.metered_settlements();
        let mut amounts = self.metered_amounts();
        let Some(maximum) = amounts.get(&key) else {
            return match history.get(&slot) {
                Some((recorded, used)) if recorded == seq.0 && used == actual.0 => {
                    SettlementResult::Duplicate
                }
                Some((recorded, _)) if recorded == seq.0 => SettlementResult::Conflict,
                _ => SettlementResult::NoEvidence,
            };
        };
        require!(actual.0 <= maximum, "Actual usage exceeds reservation");
        let refund = subtract(maximum, actual.0);
        pass.available.0 = add(pass.available.0, refund);
        policy.available.0 = add(policy.available.0, refund);
        policy.consumed.0 = add(policy.consumed.0, actual.0);
        pass.open = open_decrement(pass.open);
        policy.open = open_decrement(policy.open);
        issuer.open = open_decrement(issuer.open);
        self.passes.insert(&token_id, &pass);
        self.policies.insert(&pass.policy_id.0, &policy);
        self.issuers.insert(&pass.issuer_id.0, &issuer);
        self.reservations.remove(&key);
        amounts.remove(&key);
        if history
            .get(&slot)
            .is_none_or(|(recorded, _)| recorded < seq.0)
        {
            history.insert(&slot, &(seq.0, actual.0));
        }
        event(
            "settle_tokens",
            json!({"token_id":token_id,"seq":seq,"actual":actual,"released":U128(refund)}),
        );
        SettlementResult::Applied
    }
}

impl QuotaPass {
    pub(super) fn metered_settlements(&self) -> LookupMap<(String, u64), (u64, u128)> {
        LookupMap::new(Key::MeteredSettlements)
    }
    pub(super) fn metered_issuers(&self) -> LookupMap<u64, bool> {
        LookupMap::new(Key::MeteredIssuers)
    }

    pub(super) fn metered_amounts(&self) -> LookupMap<(String, u64), u128> {
        LookupMap::new(Key::MeteredAmounts)
    }
}
