# Skills native extraction

Date: 2026-08-06

## Outcome

The Skills capability's native policy, embedded Markdown resources, and native
characterization tests now live under `modules/skills/backend/`. The module is
an optional internal Tauri plugin and no longer extends Shep's flat command
list.

The frontend cut over atomically to these namespaced commands:

<!-- markdownlint-disable MD013 -->

| Operation | Command | Permission |
| --- | --- | --- |
| Inspect catalog | `plugin:shep-skills\|list_skills` | `shep-skills:allow-list-skills` |
| Install skill | `plugin:shep-skills\|setup_skill` | `shep-skills:allow-setup-skill` |
| Remove skill | `plugin:shep-skills\|remove_skill` | `shep-skills:allow-remove-skill` |

<!-- markdownlint-enable MD013 -->

## Boundary

The module owns:

- the fixed skill catalog and embedded skill documents;
- installation, Claude pointer, and conservative removal policy;
- command DTOs, handlers, generated permissions, and native tests.

The host owns project registration. It implements the module's narrow
`ProjectRootAuthority` port and accepts only an exact path currently registered
with `WorkspaceManager`. The plugin cannot import the host workspace code and
cannot operate on an arbitrary child or unregistered path.

## Removal path

`skills-module` is an optional Cargo feature. The normal profile enables the
plugin and its three explicit permissions. The Skills-disabled profile omits
the feature, plugin initialization, plugin crate, and permissions while keeping
the rest of Shep buildable.

The frontend remains on the existing compatibility location until the next
task moves its store, client, project action, and components together. There is
one writer for each native resource: the former host copies were moved, not
duplicated.

## Verification gate

The extraction gate covers:

- module unit and characterization tests;
- namespaced frontend command-contract and store characterization tests;
- host type-check, production build, Rust tests, and enabled Tauri build;
- a native Tauri build with `skills-module` disabled;
- module-boundary and whitespace checks.

An exact staged-tree verification is required before commit so unrelated local
work cannot mask a missing dependency.
