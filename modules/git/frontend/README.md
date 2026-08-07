# Git frontend module

Owns Git DTOs, the namespaced native client, project status and panel state,
generic project facts, and Git refresh/removal lifecycle policy.

The host composes `gitModule` through `src/core/modules/enabledModules.ts`.
Git-specific visual surfaces are migrated in the next extraction slice; until
then they use the explicitly temporary compatibility runtime exported from the
same composition point.
