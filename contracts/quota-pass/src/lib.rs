use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct QuotaPass {}

#[near]
impl QuotaPass {
    pub fn interface_version(&self) -> String {
        "0.1.0".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::QuotaPass;

    #[test]
    fn reports_foundation_interface_version() {
        assert_eq!(QuotaPass::default().interface_version(), "0.1.0");
    }
}
