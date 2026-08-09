# Rapid time to value — restart-bound agent-operated modules

## Mission

Ship one demonstrable, packaged TypeScript module that runs in Shipctl after an
explicit configuration change and manual restart. An external agent can
discover and invoke its typed capability. The module can handle directed
messages, publish and consume topics, and observe output from a terminal it
opens. The iteration ends with a verified macOS app, CLI, DMG, demo artifact,
and demo procedure under `builds/`.

This detour temporarily replaces Phases 4 and 5 of the broader module-control
plan. It uses the artifact repository, registry, message bus, module API, local
instance protocol, terminal host, and build pipeline already delivered. It
does not attempt live module replacement.

## Developer outcome

The release supports this explicit workflow:

1. add a validated module archive to an isolated state root;
2. enable its selected digest offline, receiving `restartRequired: true`;
3. start a named Shipctl instance manually;
4. list and inspect active agent-accessible capabilities;
5. invoke the demo capability with schema-validated JSON;
6. observe that the module handled a message, consumed a topic, and captured
   output from the terminal probe it launched; and
7. disable or restore prior state, then restart manually to revert.

The host never installs npm dependencies, runs package scripts, rebuilds Rust,
restarts itself, or persists bus events or terminal bytes.

## CTO proof

One unchanged host build loads admitted ESM code selected in instance state and
operates it through stable local IPC. The proof crosses the actual public
boundaries: built CLI, named app instance, validated artifact, message bridge,
terminal runtime, and packaged release. Failure to load the module leaves the
core workspace available and produces a structured diagnostic.

## Scope decisions

- Runtime modules are headless in this slice. Existing built-in UI modules stay
  statically composed. Dynamic panels and other UI contributions follow after
  the runtime boundary proves value.
- Module configuration is restart-bound. Enable and disable only change desired
  state and never restart a process.
- Agent access is capability-based. There is no arbitrary bus injection and no
  claimed module identity.
- Terminal output is an opt-in, ephemeral, flow-controlled stream associated
  with the terminal session. Low-rate module facts remain ordinary typed bus
  topics. Raw terminal chunks are not forced through the JSON topic bus.
- The demo exposes a fixed terminal probe, not arbitrary shell execution.
- No live replace, rollback engine, provider selection UI, event history,
  generic resource leases, npm registry, or production-module migration is in
  this detour.

## Work packages

1. [Restart-bound runtime](01-restart-bound-runtime.md)
2. [Agent capability and message operation](02-agent-capability-and-messages.md)
3. [Terminal stream and demonstrator](03-terminal-stream-and-demo.md)
4. [Release proof and return path](04-release-proof-and-return-path.md)

## Completion

The detour is complete only when all four work packages pass through the built
public interfaces and a verified release exists under `builds/`. Stop after
that release. Use the evidence to rewrite, retain, or discard the remaining
live-reconfiguration phases; do not start them automatically.
