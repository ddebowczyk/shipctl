// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if shipctl_ui_lib::build_info::print_requested_version(args.clone()) {
        return;
    }
    let options = match shipctl_core::instance::InstanceLaunchOptions::from_args(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("shipctl-ui: {error}");
            std::process::exit(2);
        }
    };
    if let Err(error) = shipctl_ui_lib::run_with_options(options) {
        eprintln!("shipctl-ui: {error}");
        std::process::exit(1);
    }
}
