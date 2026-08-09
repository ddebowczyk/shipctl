# Rapid terminal probe

This is the restart-bound module demonstrator for Shipctl's rapid
time-to-value release. It is example code, not host-core functionality.

`package.rs` defines the complete package: the ESM entry point, runtime
manifest, message schemas, capability definition, and integrity index. It
builds a deterministic `.shipctl-module` archive without installing npm
dependencies or running package lifecycle scripts.

From the repository root, create the archive with:

```sh
cargo run -p shipctl-rapid-terminal-probe --bin build-rapid-demo
```

Validate the complete archive contract from this example package with:

```sh
cargo test -p shipctl-rapid-terminal-probe --bin build-rapid-demo
```

The default output is
`target/rapid-time-to-value/shipctl-rapid-demo.shipctl-module`. The release
proof will copy that exact archive beside the packaged app, CLI, DMG, and its
evidence under one `builds/<build-id>/` directory.

The module deliberately exposes only one agent-accessible probe. It runs a
fixed `printf` command, observes the terminal session it owns, sends one
typed message, publishes and consumes one typed topic, and returns the
in-memory result. It neither provides arbitrary shell execution nor persists
terminal output or event payloads.
