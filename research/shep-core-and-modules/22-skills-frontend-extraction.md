# Skills frontend extraction

Date: 2026-08-06

## Outcome

The Skills frontend now lives under `modules/skills/frontend/`. Its package
owns the native client, DTO, Zustand render cache, project action menu,
lifecycle refreshes, notices, tests, and public module entrypoint.

The host's compile-time composition imports only `skillsModule` from
`@shep/module-skills`. The former host store, Tauri wrappers, shared `SkillInfo`
DTO, and `SKILLS_COMPATIBILITY_MODULE` were removed in the same cutover.

## Public contribution

`skillsModule` contributes:

- the singular optional `skills.provider` service used by TODOs through
  `ModuleSkillsPort`;
- the `skills.project-actions` project menu group;
- project-list, filesystem, and project-removal lifecycle handling.

The module retains the existing process-local cache semantics. Files under
`.agents/skills/` remain the source of truth. Refresh failures preserve the
last successful project snapshot, and install/remove mutations refresh only
their target project.

## Dependency shape

```text
src/core/modules/enabledModules.ts
              |
              v
      @shep/module-skills
              |
              +-- @shep/module-api contracts
              +-- plugin:shep-skills commands

@shep/module-todos -> ModuleHostServices.skills -> skills.provider
```

There is no TODO-to-Skills package import and no Skills-to-host source import.
The boundary checker discovers the new workspace package automatically and
enforces both rules.

## Verification gate

The frontend gate covers:

- seven module-owned behavior and command-contract tests;
- module composition and project-action failure containment;
- frontend module-boundary checks and production type-check/build;
- the panel-host smoke type-check using public module lifecycle initialization;
- the unchanged 13 native Skills tests.

The next task performs the stronger disabled and physically source-absent
build matrix before the Skills phase closes.
