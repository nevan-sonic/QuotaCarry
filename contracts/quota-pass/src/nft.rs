use super::*;
use near_contract_standards::non_fungible_token::{
    Token,
    events::{NftBurn, NftMint, NftTransfer},
    metadata::{NFT_METADATA_SPEC, NFTContractMetadata, TokenMetadata},
};
use near_sdk::{Gas, Promise, ext_contract};

const RESOLVER_GAS: Gas = Gas::from_tgas(28);
const MIN_TRANSFER_CALL_GAS: Gas = Gas::from_tgas(45);
const MAX_PAGE: u32 = 50;

#[allow(dead_code)]
#[ext_contract(ext_receiver)]
trait Receiver {
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> bool;
}

#[allow(dead_code)]
#[ext_contract(ext_resolver)]
trait Resolver {
    fn nft_resolve_transfer(&mut self, token_id: String, transfer_id: U64) -> bool;
}

#[near]
impl QuotaPass {
    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_owned(),
            name: "QuotaCarry".to_owned(),
            symbol: "QUOTA".to_owned(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        assert_token_id(&token_id);
        self.passes
            .get(&token_id)
            .map(|pass| token(token_id, pass.owner_id))
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(u128::from(self.tokens.len()))
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(
            self.owner_tokens
                .get(&account_id)
                .map_or(0, |ids| u128::from(ids.len())),
        )
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token> {
        self.page(&self.tokens, from_index, limit)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<Token> {
        self.owner_tokens
            .get(&account_id)
            .map_or_else(Vec::new, |ids| self.page(&ids, from_index, limit))
    }

    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let mut pass = self.transferable(&token_id, &receiver_id, approval_id, memo.as_deref());
        self.move_pass(&token_id, &mut pass, &receiver_id, memo.as_deref());
    }

    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(msg.len() <= 4096, "Receiver message too large");
        require!(
            env::prepaid_gas() >= MIN_TRANSFER_CALL_GAS,
            "Insufficient transfer-call gas"
        );
        let mut pass = self.transferable(&token_id, &receiver_id, approval_id, memo.as_deref());
        let mut issuer = self.issuer(pass.issuer_id);
        let previous_owner = pass.owner_id.clone();
        let transfer_id = take_id(&mut self.next_transfer);
        let start = env::storage_usage();
        commit_storage(&mut issuer, CALLBACK_BYTES);
        pass.pending = open_increment(pass.pending);
        self.pending.insert(
            &(token_id.clone(), transfer_id),
            &PendingTransfer {
                previous_owner: previous_owner.clone(),
                receiver: receiver_id.clone(),
            },
        );
        self.issuers.insert(&pass.issuer_id.0, &issuer);
        assert_growth(start, CALLBACK_BYTES);
        self.move_pass(&token_id, &mut pass, &receiver_id, memo.as_deref());
        event(
            "transfer_pending",
            json!({"token_id": token_id, "transfer_id": U64(transfer_id), "epoch": pass.epoch, "pending": pass.pending}),
        );
        ext_receiver::ext(receiver_id)
            .with_unused_gas_weight(1)
            .nft_on_transfer(
                previous_owner.clone(),
                previous_owner,
                token_id.clone(),
                msg,
            )
            .then(
                ext_resolver::ext(env::current_account_id())
                    .with_static_gas(RESOLVER_GAS)
                    .with_unused_gas_weight(0)
                    .nft_resolve_transfer(token_id, U64(transfer_id)),
            )
    }

    #[private]
    pub fn nft_resolve_transfer(&mut self, token_id: String, transfer_id: U64) -> bool {
        require!(
            env::promise_results_count() == 1,
            "Resolver requires receiver outcome"
        );
        let key = (token_id.clone(), transfer_id.0);
        let pending = self
            .pending
            .get(&key)
            .unwrap_or_else(|| env::panic_str("Unknown transfer callback"));
        let mut pass = self.pass(&token_id);
        let mut issuer = self.issuer(pass.issuer_id);
        let accepted = env::promise_result_checked(0, 5)
            .ok()
            .and_then(|value| near_sdk::serde_json::from_slice::<bool>(&value).ok())
            == Some(false);
        let restored = !accepted && pass.owner_id == pending.receiver;
        pass.pending = open_decrement(pass.pending);
        if restored {
            self.move_pass(&token_id, &mut pass, &pending.previous_owner, None);
        } else {
            self.passes.insert(&token_id, &pass);
        }
        self.pending.remove(&key);
        release_storage(&mut issuer, CALLBACK_BYTES);
        self.issuers.insert(&pass.issuer_id.0, &issuer);
        event(
            "transfer_resolved",
            json!({"token_id": token_id, "transfer_id": transfer_id, "owner_id": pass.owner_id,
            "epoch": pass.epoch, "restored": restored, "pending": pass.pending}),
        );
        !restored
    }
}

impl QuotaPass {
    fn page(
        &self,
        ids: &UnorderedSet<String>,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<Token> {
        let Ok(start) = u64::try_from(from_index.unwrap_or(U128(0)).0) else {
            return Vec::new();
        };
        let end = start
            .saturating_add(u64::from(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE)))
            .min(ids.len());
        (start..end)
            .filter_map(|index| self.nft_token(ids.as_vector().get(index)?))
            .collect()
    }

    fn transferable(
        &self,
        id: &String,
        receiver: &AccountId,
        approval: Option<u64>,
        memo: Option<&str>,
    ) -> Pass {
        assert_one_yocto();
        require!(approval.is_none(), "Approval management disabled");
        require!(
            memo.is_none_or(|value| value.len() <= 256),
            "Memo too large"
        );
        let pass = self.pass(id);
        require!(
            pass.owner_id == env::predecessor_account_id(),
            "Owner required"
        );
        require!(
            &pass.owner_id != receiver,
            "Receiver must differ from owner"
        );
        pass
    }

    fn move_pass(
        &mut self,
        id: &String,
        pass: &mut Pass,
        receiver: &AccountId,
        memo: Option<&str>,
    ) {
        let start = env::storage_usage();
        let old = pass.owner_id.clone();
        pass.epoch.0 = increment(pass.epoch.0);
        self.remove_owner_token(&old, id);
        self.add_owner_token(receiver, id);
        pass.owner_id = receiver.clone();
        self.passes.insert(id, pass);
        assert_growth(start, 768);
        nft_event(
            "nft_transfer",
            NftTransfer {
                old_owner_id: &old,
                new_owner_id: receiver,
                token_ids: &[id.as_str()],
                authorized_id: None,
                memo,
            },
        );
    }

    pub(super) fn mint_pass(
        &mut self,
        issuer: &mut Issuer,
        owner_id: AccountId,
        issuer_id: U64,
        policy_id: U64,
        available: U128,
    ) -> String {
        commit_storage(issuer, PASS_BYTES);
        let start = env::storage_usage();
        let id = take_id(&mut self.next_token).to_string();
        let pass = Pass {
            owner_id,
            issuer_id,
            policy_id,
            available,
            open: 0,
            epoch: U64(0),
            next_reservation_seq: U64(0),
            mutation_seq: U64(0),
            pending: 0,
        };
        self.tokens.insert(&id);
        self.add_owner_token(&pass.owner_id, &id);
        self.passes.insert(&id, &pass);
        assert_growth(start, 1024);
        nft_event(
            "nft_mint",
            NftMint {
                owner_id: &pass.owner_id,
                token_ids: &[id.as_str()],
                memo: None,
            },
        );
        id
    }

    pub(super) fn burn_pass(&mut self, id: &String, owner: &AccountId) {
        self.passes.remove(id);
        self.tokens.remove(id);
        self.remove_owner_token(owner, id);
        for slot in 0..SETTLEMENT_WINDOW {
            self.settlements.remove(&(id.clone(), slot));
            self.metered_settlements().remove(&(id.clone(), slot));
        }
        nft_event(
            "nft_burn",
            NftBurn {
                owner_id: owner,
                token_ids: &[id.as_str()],
                authorized_id: None,
                memo: None,
            },
        );
    }

    fn add_owner_token(&mut self, owner: &AccountId, id: &String) {
        let mut tokens = self.owner_tokens.get(owner).unwrap_or_else(|| {
            UnorderedSet::new(Key::OwnerSet(env::sha256_array(owner.as_bytes())))
        });
        require!(tokens.insert(id), "Owner index duplicate");
        self.owner_tokens.insert(owner, &tokens);
    }

    fn remove_owner_token(&mut self, owner: &AccountId, id: &String) {
        let mut tokens = self
            .owner_tokens
            .get(owner)
            .unwrap_or_else(|| env::panic_str("Missing owner index"));
        require!(tokens.remove(id), "Missing token in owner index");
        if tokens.is_empty() {
            self.owner_tokens.remove(owner);
        } else {
            self.owner_tokens.insert(owner, &tokens);
        }
    }
}

fn token(token_id: String, owner_id: AccountId) -> Token {
    Token {
        token_id,
        owner_id,
        approved_account_ids: None,
        metadata: Some(TokenMetadata {
            title: Some("QuotaCarry inference pass".to_owned()),
            description: Some("Issuer-backed allowance for bounded inference".to_owned()),
            media: None,
            media_hash: None,
            copies: None,
            issued_at: None,
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: None,
            reference: None,
            reference_hash: None,
        }),
    }
}

fn nft_event(name: &str, data: impl near_sdk::serde::Serialize) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": "nep171", "version": "1.2.0", "event": name, "data": [data],
        })
    ));
}
