# Repository operations

Each supported repository operation is a capability directory with a validated
`capability.yaml` and a thin `justfile`. The root `ops.yaml` selects the active
provider for each interface; it does not implement runtime dispatch.

Capability manifests declare dependencies, owned/read/generated paths, commands,
and agent procedures. Command recipes contain only delegation until their backing
scripts move into the capability in later migration passes.

