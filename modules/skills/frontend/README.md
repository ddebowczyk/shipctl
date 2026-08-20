# Shipctl Skills frontend module

This package owns the Skills DTO, namespaced native client, project-scoped
render cache, project action/provider contributions, and activation-owned
catalog refreshes through `@shipctl/module-api`.

The artifact registers `skillsContributions` through its direct activation
context. No store or client is public, and no static module wrapper is exposed.
