# Shipctl Skills frontend module

This package owns the Skills DTO, namespaced native client, project-scoped
render cache, project action contribution, lifecycle refreshes, and optional
Skills service provided to other capabilities through `@shipctl/module-api`.

The host may import `skillsModule` only from this package's public entrypoint
and only in compile-time module composition. No store or client is public.
