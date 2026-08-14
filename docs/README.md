# Documentation policy

`docs/` holds durable, shared reference material. New architecture notes,
accepted decisions, and current operating reference should be added here and
committed deliberately.

`docs/plans/` and `docs/ops/` remain ignored local working areas. Files already
tracked there stay tracked; promote a new item only when it is ready to become
shared reference. Repository-operation procedures belong with their owner under
`ops/<capability>/skills/`.

`research/` is ignored local evidence and working notes. Promote its settled
conclusions into this directory instead of bulk-committing raw investigations.

The canonical inventory of the repository root is
[`ops/repository/root-map.yaml`](../ops/repository/root-map.yaml). Run
`just repository map` to view it and `just repository validate` to catch a new
root entry before it becomes unclassified noise.
