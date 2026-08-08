use std::ffi::{OsStr, OsString};

use shipctl_core::build_info::BuildIdentity;

pub const APP_VERSION: &str = env!("SHIPCTL_APP_VERSION");

pub fn print_requested_version(args: impl IntoIterator<Item = OsString>) -> bool {
    let args: Vec<OsString> = args.into_iter().skip(1).collect();
    if args.first() != Some(&OsString::from("--version")) {
        return false;
    }

    let identity = BuildIdentity::new("ui", APP_VERSION);
    let json = args
        .windows(2)
        .any(|pair| pair[0] == OsStr::new("--output") && pair[1] == OsStr::new("json"));
    if json {
        println!(
            "{}",
            serde_json::to_string(&identity).expect("build identity is serializable")
        );
    } else {
        println!(
            "shipctl-ui {} (role {}, control protocol {})",
            identity.app_version, identity.executable_role, identity.control_protocol_version
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_normal_ui_launches() {
        assert!(!print_requested_version([OsString::from("shipctl-ui")]));
    }

    #[test]
    fn app_version_is_compiled_from_the_tauri_source_of_truth() {
        assert_ne!(APP_VERSION, "0.0.0");
    }
}
