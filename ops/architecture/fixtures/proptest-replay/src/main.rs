use proptest::prelude::*;
use proptest::test_runner::{Config, RngSeed, TestError, TestRunner};

fn seed_argument() -> Result<u64, String> {
    let mut arguments = std::env::args().skip(1);
    match (
        arguments.next().as_deref(),
        arguments.next(),
        arguments.next(),
    ) {
        (Some("--seed"), Some(seed), None) => seed
            .parse::<u64>()
            .map_err(|error| format!("invalid --seed value: {error}")),
        _ => Err("usage: shipctl-architecture-proptest-replay --seed <u64>".to_owned()),
    }
}

fn main() -> Result<(), String> {
    let seed = seed_argument()?;
    let config = Config {
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        ..Config::default()
    };
    let mut runner = TestRunner::new(config);
    let strategy = 1_u32..=u32::MAX;
    match runner.run(&strategy, |_value| {
        Err(TestCaseError::fail("injected architecture replay failure"))
    }) {
        Err(TestError::Fail(_reason, minimized)) => {
            println!(
                "{{\"failed\":true,\"property_id\":\"PROP-A-REPLAY-001\",\"seed\":\"{seed}\",\"counterexample\":[{minimized}]}}"
            );
            Ok(())
        }
        Err(TestError::Abort(reason)) => Err(format!("property aborted: {reason}")),
        Ok(()) => Err("injected property unexpectedly passed".to_owned()),
    }
}
