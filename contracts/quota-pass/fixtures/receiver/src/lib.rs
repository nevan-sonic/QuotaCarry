use near_sdk::{AccountId, Gas, NearToken, PromiseOrValue, env, ext_contract, near};

#[allow(dead_code)]
#[ext_contract(ext_nft)]
trait Nft {
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String);
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, msg: String);
    fn split(
        &mut self,
        token_id: String,
        amount: String,
        expected_epoch: String,
        expected_mutation_seq: String,
    );
    fn reserve(
        &mut self,
        token_id: String,
        holder_id: AccountId,
        expected_epoch: String,
        seq: String,
        request_commitment: String,
        valid_through_height: String,
    );
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait Callback {
    fn request_return(&self) -> bool;
}

#[near(contract_state)]
#[derive(Default)]
pub struct Receiver;

#[near]
impl Receiver {
    pub fn nft_on_transfer(
        &self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<near_sdk::serde_json::Value> {
        assert_eq!(sender_id, previous_owner_id);
        match msg.as_str() {
            "accept" => PromiseOrValue::Value(false.into()),
            "return" => PromiseOrValue::Value(true.into()),
            "panic" => env::panic_str("Fixture receiver failure"),
            "malformed" => PromiseOrValue::Value("not a boolean".into()),
            "reserve" => PromiseOrValue::Promise(
                ext_nft::ext(env::predecessor_account_id())
                    .with_static_gas(Gas::from_tgas(18))
                    .reserve(
                        token_id,
                        env::current_account_id(),
                        "4".to_owned(),
                        "4".to_owned(),
                        "a".repeat(64),
                        env::block_height().saturating_add(100).to_string(),
                    )
                    .then(
                        ext_self::ext(env::current_account_id())
                            .with_static_gas(Gas::from_tgas(5))
                            .request_return(),
                    ),
            ),
            _ => {
                let (kind, account) = msg.split_once(':').expect("Fixture mode");
                let nft = ext_nft::ext(env::predecessor_account_id())
                    .with_attached_deposit(NearToken::from_yoctonear(1));
                let promise = match kind {
                    "split" => nft.with_static_gas(Gas::from_tgas(18)).split(
                        token_id,
                        "1".to_owned(),
                        account.to_owned(),
                        "2".to_owned(),
                    ),
                    "forward" => nft
                        .with_static_gas(Gas::from_tgas(18))
                        .nft_transfer(account.parse().expect("Recipient"), token_id),
                    "nested" => nft.with_static_gas(Gas::from_tgas(100)).nft_transfer_call(
                        account.parse().expect("Recipient"),
                        token_id,
                        "return".to_owned(),
                    ),
                    _ => env::panic_str("Fixture mode"),
                };
                PromiseOrValue::Promise(
                    promise.then(
                        ext_self::ext(env::current_account_id())
                            .with_static_gas(Gas::from_tgas(5))
                            .request_return(),
                    ),
                )
            }
        }
    }

    #[private]
    pub fn request_return(&self) -> bool {
        true
    }
}
