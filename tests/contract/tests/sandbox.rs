use near_workspaces::{
    Account, Contract,
    result::ExecutionFinalResult,
    types::{Gas, NearToken},
};
use serde_json::{Value, json};
use std::{error::Error, time::Duration};

type TestResult<T = ()> = Result<T, Box<dyn Error>>;
const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn call(
    caller: &Account,
    contract: &Contract,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> TestResult<ExecutionFinalResult> {
    Ok(caller
        .call(contract.id(), method)
        .args_json(args)
        .deposit(deposit)
        .gas(Gas::from_tgas(290))
        .transact()
        .await?)
}

async fn view(contract: &Contract, method: &str, args: Value) -> TestResult<Value> {
    Ok(contract.view(method).args_json(args).await?.json()?)
}

fn verify_event(result: &ExecutionFinalResult, standard: &str, version: &str, name: &str) {
    assert!(
        result.logs().iter().any(|log| {
            log.strip_prefix("EVENT_JSON:")
                .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
                .is_some_and(|event| {
                    event["standard"] == standard
                        && event["version"] == version
                        && event["event"] == name
                        && event["data"].is_array()
                })
        }),
        "Expected {standard} event {name}, got {:?}",
        result.logs()
    );
}

async fn conservation(contract: &Contract) -> TestResult {
    let policy = view(contract, "get_policy", json!({"policy_id":"0"})).await?;
    let passes = view(contract, "nft_tokens", json!({})).await?;
    let mut available = 0u128;
    let mut open = 0u128;
    for pass in passes.as_array().unwrap() {
        let pass = view(
            contract,
            "get_allowance",
            json!({"token_id":pass["token_id"]}),
        )
        .await?;
        if pass["policy_id"] == "0" {
            available += decimal(&pass["available"]);
            open += u128::from(pass["open"].as_u64().unwrap());
        }
    }
    assert_eq!(available, decimal(&policy["available"]));
    assert_eq!(open, u128::from(policy["open"].as_u64().unwrap()));
    assert_eq!(
        decimal(&policy["issued"]),
        available + open + decimal(&policy["consumed"])
    );
    Ok(())
}

fn decimal(value: &Value) -> u128 {
    value.as_str().unwrap().parse().unwrap()
}

fn reserve_args(token: &str, holder: &Account, epoch: u64, seq: u64, deadline: u64) -> Value {
    json!({"token_id":token,"holder_id":holder.id(),"expected_epoch":epoch.to_string(),
        "seq":seq.to_string(),"request_commitment":DIGEST,"valid_through_height":deadline.to_string()})
}

#[tokio::test]
#[ignore = "requires v1 and v2 WASM artifacts"]
async fn upgrade_preserves_open_request_reservations() -> TestResult {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker
        .dev_deploy(&std::fs::read(std::env::var("QUOTA_PASS_V1_WASM")?)?)
        .await?;
    let issuer = worker.dev_create_account().await?;
    let relay = worker.dev_create_account().await?;
    let settler = worker.dev_create_account().await?;
    let holder = worker.dev_create_account().await?;
    let zero = NearToken::from_yoctonear(0);
    call(
        contract.as_account(),
        &contract,
        "new",
        json!({"governance":contract.id()}),
        zero,
    )
    .await?
    .into_result()?;
    let roles = json!({"controller":issuer.id(),"authorizer":relay.id(),"settler":settler.id(),"lifetime_cap":"500","max_open":4});
    call(
        contract.as_account(),
        &contract,
        "register_issuer",
        roles.clone(),
        NearToken::from_near(1),
    )
    .await?
    .into_result()?;
    call(
        &issuer,
        &contract,
        "create_policy",
        json!({"issuer_id":"0","policy_hash":DIGEST,"lifetime_cap":"500","max_open":4}),
        zero,
    )
    .await?
    .into_result()?;
    call(
        &issuer,
        &contract,
        "issue",
        json!({"policy_id":"0","receiver_id":holder.id(),"amount":"10","expected_issue_seq":"0"}),
        zero,
    )
    .await?
    .into_result()?;
    let height = worker.view_block().await?.height();
    call(
        &relay,
        &contract,
        "reserve",
        reserve_args("0", &holder, 0, 0, height + 100),
        zero,
    )
    .await?
    .into_result()?;
    let pass = view(&contract, "get_allowance", json!({"token_id":"0"})).await?;
    let policy = view(&contract, "get_policy", json!({"policy_id":"0"})).await?;
    let reservation = view(
        &contract,
        "get_reservation",
        json!({"token_id":"0","seq":"0"}),
    )
    .await?;
    contract
        .as_account()
        .deploy(&std::fs::read(std::env::var("QUOTA_PASS_WASM")?)?)
        .await?
        .into_result()?;
    assert_eq!(
        view(&contract, "get_allowance", json!({"token_id":"0"})).await?,
        pass
    );
    assert_eq!(
        view(&contract, "get_policy", json!({"policy_id":"0"})).await?,
        policy
    );
    assert_eq!(
        view(
            &contract,
            "get_reservation",
            json!({"token_id":"0","seq":"0"})
        )
        .await?,
        reservation
    );
    call(
        &settler,
        &contract,
        "settle",
        json!({"token_id":"0","seq":"0","disposition":"consume"}),
        zero,
    )
    .await?
    .into_result()?;
    assert_eq!(
        view(&contract, "get_policy", json!({"policy_id":"0"})).await?["consumed"],
        "1"
    );
    call(
        contract.as_account(),
        &contract,
        "register_metered_issuer",
        roles,
        NearToken::from_near(1),
    )
    .await?
    .into_result()?;
    call(
        &issuer,
        &contract,
        "create_policy",
        json!({"issuer_id":"1","policy_hash":DIGEST,"lifetime_cap":"500","max_open":4}),
        zero,
    )
    .await?
    .into_result()?;
    assert_eq!(
        view(&contract, "get_policy", json!({"policy_id":"1"})).await?["denomination_version"],
        2
    );
    conservation(&contract).await
}

#[tokio::test]
#[ignore = "requires compiled QuotaCarry and receiver WASM paths"]
async fn sandbox_contract() -> TestResult {
    tokio::time::timeout(Duration::from_secs(420), run()).await??;
    Ok(())
}

async fn run() -> TestResult {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker
        .dev_deploy(&std::fs::read(std::env::var("QUOTA_PASS_WASM")?)?)
        .await?;
    let receiver_wasm = std::fs::read(std::env::var("QUOTA_RECEIVER_WASM")?)?;
    let receiver = worker.dev_deploy(&receiver_wasm).await?;
    let nested = worker.dev_deploy(&receiver_wasm).await?;
    let issuer = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    let settler = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let zero = NearToken::from_yoctonear(0);
    let one = NearToken::from_yoctonear(1);
    call(
        contract.as_account(),
        &contract,
        "new",
        json!({"governance":contract.id()}),
        zero,
    )
    .await?
    .into_result()?;
    let issuer_args = json!({"controller":issuer.id(),"authorizer":relayer.id(),"settler":settler.id(),
        "lifetime_cap":u128::MAX.to_string(),"max_open":16});
    assert!(
        call(
            &alice,
            &contract,
            "register_issuer",
            issuer_args.clone(),
            NearToken::from_near(1)
        )
        .await?
        .is_failure()
    );
    assert!(
        call(
            contract.as_account(),
            &contract,
            "register_issuer",
            issuer_args.clone(),
            zero
        )
        .await?
        .is_failure()
    );
    call(
        contract.as_account(),
        &contract,
        "register_issuer",
        issuer_args,
        NearToken::from_near(1),
    )
    .await?
    .into_result()?;
    call(
        &issuer,
        &contract,
        "create_policy",
        json!({"issuer_id":"0","policy_hash":DIGEST,
        "lifetime_cap":u128::MAX.to_string(),"max_open":16}),
        zero,
    )
    .await?
    .into_result()?;
    let issue_args =
        json!({"policy_id":"0","receiver_id":alice.id(),"amount":"100","expected_issue_seq":"0"});
    assert!(
        call(&alice, &contract, "issue", issue_args.clone(), zero)
            .await?
            .is_failure()
    );
    let mint = call(&issuer, &contract, "issue", issue_args, zero).await?;
    verify_event(&mint, "nep171", "1.2.0", "nft_mint");
    verify_event(&mint, "quotacarry", "1.0.0", "issue");
    let token: String = mint.json()?;
    let height = worker.view_block().await?.height();
    let deadline = height + 120;
    for seq in 0..3 {
        let result = call(
            &relayer,
            &contract,
            "reserve",
            reserve_args(&token, &alice, 0, seq, deadline),
            zero,
        )
        .await?;
        verify_event(&result, "quotacarry", "1.0.0", "reserve");
        result.into_result()?;
    }
    let pass = view(&contract, "get_allowance", json!({"token_id":token})).await?;
    assert_eq!(pass["available"], "97");
    assert_eq!(pass["open"], 3);
    let transfer = json!({"receiver_id":bob.id(),"token_id":token});
    assert!(
        call(&bob, &contract, "nft_transfer", transfer.clone(), one)
            .await?
            .is_failure()
    );
    let moved = call(&alice, &contract, "nft_transfer", transfer, one).await?;
    verify_event(&moved, "nep171", "1.2.0", "nft_transfer");
    moved.into_result()?;
    assert!(
        call(
            &relayer,
            &contract,
            "reserve",
            reserve_args(&token, &alice, 0, 3, deadline),
            zero
        )
        .await?
        .is_failure()
    );
    call(
        &relayer,
        &contract,
        "reserve",
        reserve_args(&token, &bob, 1, 3, deadline),
        zero,
    )
    .await?
    .into_result()?;
    for (seq, disposition) in [
        (0, "consume"),
        (1, "consume"),
        (2, "release"),
        (3, "release"),
    ] {
        let args = json!({"token_id":token,"seq":seq.to_string(),"disposition":disposition});
        assert!(
            call(&alice, &contract, "settle", args.clone(), zero)
                .await?
                .is_failure()
        );
        let settled = call(&settler, &contract, "settle", args.clone(), zero).await?;
        verify_event(&settled, "quotacarry", "1.0.0", disposition);
        assert_eq!(settled.json::<String>()?, "applied");
        assert_eq!(
            call(&settler, &contract, "settle", args, zero)
                .await?
                .json::<String>()?,
            "duplicate"
        );
    }
    assert_eq!(
        call(
            &settler,
            &contract,
            "settle",
            json!({"token_id":token,"seq":"2","disposition":"consume"}),
            zero
        )
        .await?
        .json::<String>()?,
        "conflict"
    );
    assert!(
        call(
            &relayer,
            &contract,
            "reserve",
            reserve_args(&token, &bob, 1, 3, deadline),
            zero
        )
        .await?
        .is_failure()
    );
    assert_eq!(
        view(&contract, "get_allowance", json!({"token_id":token})).await?["available"],
        "98"
    );
    conservation(&contract).await?;

    let storage_before = contract.view_account().await?.storage_usage;
    assert!(
        call(
            &bob,
            &contract,
            "split",
            json!({"token_id":token,"amount":"0","expected_epoch":"1","expected_mutation_seq":"0"}),
            one
        )
        .await?
        .is_failure()
    );
    let child: String = call(
        &bob,
        &contract,
        "split",
        json!({"token_id":token,"amount":"10","expected_epoch":"1","expected_mutation_seq":"0"}),
        one,
    )
    .await?
    .json()?;
    let split_growth = contract.view_account().await?.storage_usage - storage_before;
    assert!((1..=4096).contains(&split_growth));
    eprintln!("sandbox split storage growth: {split_growth} bytes");
    assert!(
        call(
            &bob,
            &contract,
            "split",
            json!({"token_id":token,"amount":"1","expected_epoch":"1","expected_mutation_seq":"0"}),
            one
        )
        .await?
        .is_failure()
    );
    let merge = call(
        &bob,
        &contract,
        "merge",
        json!({"target_id":token,"source_id":child,"target_epoch":"1","source_epoch":"0",
        "target_mutation_seq":"1","source_mutation_seq":"0"}),
        one,
    )
    .await?;
    verify_event(&merge, "nep171", "1.2.0", "nft_burn");
    merge.into_result()?;
    assert_eq!(contract.view_account().await?.storage_usage, storage_before);
    conservation(&contract).await?;

    call(&issuer,&contract,"rotate_roles",json!({"issuer_id":"0","controller":issuer.id(),"authorizer":receiver.id(),"settler":settler.id()}),zero).await?.into_result()?;
    for (mode, recipient, restored) in [
        ("split:2".to_owned(), receiver.id(), true),
        ("reserve".to_owned(), receiver.id(), true),
        ("return".to_owned(), receiver.id(), true),
        ("panic".to_owned(), receiver.id(), true),
        ("malformed".to_owned(), receiver.id(), true),
        ("missing".to_owned(), alice.id(), true),
        (format!("nested:{}", nested.id()), receiver.id(), true),
        (format!("forward:{}", alice.id()), receiver.id(), false),
    ] {
        let outcome = call(
            &bob,
            &contract,
            "nft_transfer_call",
            json!({"receiver_id":recipient,"token_id":token,"msg":mode}),
            one,
        )
        .await?;
        verify_event(&outcome, "quotacarry", "1.0.0", "transfer_pending");
        verify_event(&outcome, "quotacarry", "1.0.0", "transfer_resolved");
        if mode.starts_with("split:") || mode == "reserve" {
            assert!(format!("{:?}", outcome.receipt_failures()).contains("Transfer unresolved"));
        }
        let gas = outcome.total_gas_burnt.as_gas();
        assert_eq!(outcome.json::<bool>()?, !restored);
        let pass = view(&contract, "get_allowance", json!({"token_id":token})).await?;
        assert_eq!(
            pass["owner_id"],
            if restored {
                bob.id().as_str()
            } else {
                alice.id().as_str()
            }
        );
        assert_eq!(pass["pending"], 0);
        assert_eq!(pass["available"], "98");
        eprintln!("sandbox callback {mode}: {gas} gas");
        conservation(&contract).await?;
    }

    call(&issuer,&contract,"rotate_roles",json!({"issuer_id":"0","controller":issuer.id(),"authorizer":relayer.id(),"settler":settler.id()}),zero).await?.into_result()?;
    let pass = view(&contract, "get_allowance", json!({"token_id":token})).await?;
    assert!(decimal(&pass["epoch"]) > 1);
    let height = worker.view_block().await?.height();
    let stale = call(
        &relayer,
        &contract,
        "reserve",
        reserve_args(&token, &alice, 0, 4, height + 120),
        zero,
    )
    .await?;
    assert!(stale.is_failure());
    assert_eq!(
        view(&contract, "get_allowance", json!({"token_id":token})).await?,
        pass
    );
    let accepted = call(
        &alice,
        &contract,
        "nft_transfer_call",
        json!({"receiver_id":receiver.id(),"token_id":token,"msg":"accept"}),
        one,
    )
    .await?;
    assert!(accepted.json::<bool>()?);
    assert_eq!(
        view(&contract, "nft_token", json!({"token_id":token})).await?["owner_id"],
        receiver.id().as_str()
    );
    assert_eq!(
        view(
            &contract,
            "nft_supply_for_owner",
            json!({"account_id":receiver.id()})
        )
        .await?,
        "1"
    );
    assert!(
        call(
            &alice,
            &contract,
            "nft_resolve_transfer",
            json!({"token_id":token,"transfer_id":"0"}),
            zero
        )
        .await?
        .is_failure()
    );
    conservation(&contract).await?;

    call(
        &issuer,
        &contract,
        "create_policy",
        json!({"issuer_id":"0","policy_hash":"b".repeat(64),"lifetime_cap":"1","max_open":1}),
        zero,
    )
    .await?
    .into_result()?;
    let capped: String = call(
        &issuer,
        &contract,
        "issue",
        json!({"policy_id":"1","receiver_id":alice.id(),"amount":"1","expected_issue_seq":"1"}),
        zero,
    )
    .await?
    .json()?;
    assert!(
        call(
            &issuer,
            &contract,
            "issue",
            json!({"policy_id":"1","receiver_id":alice.id(),"amount":"1","expected_issue_seq":"2"}),
            zero
        )
        .await?
        .is_failure()
    );
    let other: String = call(
        &issuer,
        &contract,
        "issue",
        json!({"policy_id":"0","receiver_id":alice.id(),"amount":"1","expected_issue_seq":"2"}),
        zero,
    )
    .await?
    .json()?;
    assert!(call(&alice,&contract,"merge",json!({"target_id":capped,"source_id":other,"target_epoch":"0","source_epoch":"0","target_mutation_seq":"0","source_mutation_seq":"0"}),one).await?.is_failure());
    assert_eq!(
        view(&contract, "get_allowance", json!({"token_id":capped})).await?["available"],
        "1"
    );
    conservation(&contract).await
}
