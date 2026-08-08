// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if shipctl_ui_lib::build_info::print_requested_version(args.clone()) {
        return;
    }
    let (instance_args, module_loader_probe_request) = match split_module_loader_probe(args) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("shipctl-ui: {error}");
            std::process::exit(2);
        }
    };
    let options = match shipctl_core::instance::InstanceLaunchOptions::from_args(instance_args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("shipctl-ui: {error}");
            std::process::exit(2);
        }
    };
    if let Err(error) =
        shipctl_ui_lib::run_with_options_and_loader_probe(options, module_loader_probe_request)
    {
        eprintln!("shipctl-ui: {error}");
        std::process::exit(1);
    }
}

fn split_module_loader_probe(
    args: Vec<std::ffi::OsString>,
) -> Result<(Vec<std::ffi::OsString>, Option<std::path::PathBuf>), String> {
    let mut instance_args = Vec::with_capacity(args.len());
    let mut request = None;
    let mut arguments = args.into_iter();
    if let Some(program) = arguments.next() {
        instance_args.push(program);
    }
    while let Some(argument) = arguments.next() {
        if argument == "--module-loader-probe" {
            if request.is_some() {
                return Err("--module-loader-probe may be supplied once".to_owned());
            }
            let value = arguments
                .next()
                .ok_or_else(|| "--module-loader-probe requires a request path".to_owned())?;
            request = Some(std::path::PathBuf::from(value));
        } else {
            instance_args.push(argument);
        }
    }
    Ok((instance_args, request))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_internal_probe_flag_before_instance_parsing() {
        let (args, request) = split_module_loader_probe(vec![
            "shipctl-ui".into(),
            "--name".into(),
            "loader-test".into(),
            "--module-loader-probe".into(),
            "/tmp/request.json".into(),
        ])
        .unwrap();

        assert_eq!(args, vec!["shipctl-ui", "--name", "loader-test"]);
        assert_eq!(
            request.unwrap(),
            std::path::PathBuf::from("/tmp/request.json")
        );
    }
}
