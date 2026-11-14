use near_sdk::{AccountId, Gas, NearToken, Promise, PromiseOrValue, env, ext_contract, near};

#[allow(dead_code)]
#[ext_contract(ext_nft)]
trait Nft {
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String);
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, msg: String);
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
            _ => {
                let (kind, account) = msg.split_once(':').expect("Fixture mode");
                let recipient = account.parse().expect("Recipient");
                let nft = ext_nft::ext(env::predecessor_account_id())
                    .with_attached_deposit(NearToken::from_yoctonear(1));
                let promise = match kind {
                    "forward" => nft
                        .with_static_gas(Gas::from_tgas(18))
                        .nft_transfer(recipient, token_id),
                    "nested" => nft.with_static_gas(Gas::from_tgas(100)).nft_transfer_call(
                        recipient,
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
