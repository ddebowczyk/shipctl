# Git frontend module

Owns Git DTOs, the namespaced native client, project status and panel state,
generic project facts, direct artifact contributions, durable preferences, and
activation-owned refresh/removal lifecycle policy.

The host admits the Git artifact through the runtime module registry. Its
runtime consumes declared Git, project-catalog, and plugin-data services; raw
`git-fs-changed` transport stays in the trusted platform adapter. Visual
surfaces enter only through declared module contributions and the shared module
API.
