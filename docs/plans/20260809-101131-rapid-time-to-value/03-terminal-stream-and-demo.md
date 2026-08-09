# Work package 3 — terminal stream and demonstrator

## Outcome

The packaged demo module can observe output from a terminal session it opens,
without persisting bytes or taking over the UI terminal's consumer.

## Required delivery

- Extend the module terminal launch contract with an optional output listener.
  It receives the same typed data/exit events as the host after normal terminal
  flow control and only for the session created by that launch.
- Detach the listener when the terminal exits or the module deactivates. A slow
  or failing observer must not block terminal rendering, acknowledgement, or
  cleanup.
- Keep terminal started/exited facts suitable for ordinary typed topics. Keep
  byte chunks on the dedicated terminal stream boundary.
- Package a deterministic `rapid-demo` ESM artifact containing:
  - a new capability definition and provider binding;
  - an agent-accessible typed `probe` port;
  - directed-message and topic declarations;
  - a fixed `/usr/bin/printf` terminal probe; and
  - in-memory status showing the last output plus message/topic counters.
- Keep the demonstrator source under `examples/rapid-terminal-probe/`; host
  core owns only generic artifact admission, module loading, messaging, and
  terminal-session services.
- Add one reproducible command — `cargo run -p shipctl-rapid-terminal-probe
  --bin build-rapid-demo` — that builds the artifact without npm install or
  lifecycle scripts.

## Acceptance

- An agent port call starts the fixed terminal probe and returns only after the
  module observes its expected output and exit.
- The UI terminal receives the same output and normal zero-exit cleanup still
  works.
- Another module/session cannot receive the stream without owning or explicitly
  attaching to that session.
- Terminal bytes, topic payloads, and counters are absent from registry and
  saved workspace state.
- Module deactivation or instance shutdown removes all listeners.
