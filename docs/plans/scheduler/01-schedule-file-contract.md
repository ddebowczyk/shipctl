# Schedule file contract

## Location and discovery

Add `schedule_root` to `ShipctlPaths`, derived as `<state-root>/schedules`.
State archives treat this directory as a durable source, preserving the current
path-safety and multi-instance rules.

Load direct regular files ending in `.yaml` or `.yml`, in normalized path order.
Do not recurse, follow symlinks, or infer schedules from other files. One file
contains exactly one schedule. Schedule IDs must be unique across the complete
directory snapshot.

## Initial schema

```yaml
schema_version: 1
id: agents.wakeup
enabled: true
cron: "*/5 * * * * Europe/Warsaw"
target:
  kind: channel
  id: agents.wakeup
message:
  type: shipctl.agent.wakeup
  version: 1
  payload:
    reason: scheduled
```

`target.kind` is either `channel` or `topic`; no other execution kind exists.
The schema is strict and rejects unknown fields. Cron expressions include an
explicit timezone. No machine-local timezone default is inferred.

The message type and version must match the target's active message contract.
The payload must pass the same schema, size, redaction, and grant validation as
an ordinary bus send or publish. The target contract must explicitly allow the
core scheduler as a sender.

## Prohibited fields and behaviors

A schedule cannot specify:

- shell command, executable, script, working directory, or environment;
- filesystem operation or arbitrary Tauri command;
- module identity or grant escalation;
- retry loop, timeout, or persistence policy;
- a different instance or external network destination.

Secrets are referenced through the receiving capability's normal secret
mechanism. A schedule payload containing a field marked secret fails refresh;
inspection never prints secret-marked values.

## Identity and generation

The stable schedule identity is its `id`; filename is provenance, not identity.
Changing an accepted definition creates a new in-memory schedule generation.
The loader computes a canonical SHA-256 digest for the complete accepted
snapshot so agents can prove which files are active.

Renaming an unchanged file changes provenance but not delivery semantics.
Duplicate IDs, even with identical content, reject the whole refresh.

## Contract fixtures

Provide shared valid and invalid YAML fixtures for:

- channel and topic targets;
- disabled schedules;
- DST transitions and multiple IANA zones;
- unknown fields and unsupported schema versions;
- duplicate IDs and unsafe paths;
- malformed cron expressions;
- missing, incompatible, or unauthorized message contracts;
- invalid, oversized, or secret-bearing payloads.

Rust owns runtime parsing. TypeScript consumes the normalized JSON golden shape
used by inspection; modules do not parse schedule YAML.
