# Goals and constraints

## Goals

The extension architecture must permit a module to be:

- developed in its own repository or package workspace;
- built and tested without building the Shep desktop application;
- distributed with its executable code, UI, schemas, migrations, icons,
  documentation, and other resources;
- discovered from an approved local directory or extension catalogue;
- installed and activated while keeping the main application bundle unchanged;
- disabled without destroying its code or user data;
- upgraded atomically with rollback to a previous compatible version;
- removed without leaving commands, listeners, panels, tasks, or processes
  registered in the host;
- granted only the specific host capabilities it needs;
- diagnosed independently through structured lifecycle and operation telemetry.

## Non-goals

The first extension platform should not attempt to provide:

- arbitrary direct access to every internal Rust or TypeScript service;
- extension-to-extension implementation imports;
- a general NPM- or Cargo-compatible dependency resolver;
- hot replacement of built-in security-critical services;
- arbitrary unsigned code loading;
- transparent unloading of JavaScript injected into the main webview;
- mobile-platform support before the desktop security and packaging model is
  proven;
- an extension marketplace before local packaging, compatibility, and rollback
  are reliable.

## Tauri constraint

Tauri plugins are Cargo crates with optional NPM packages and are registered as
part of application construction. They are appropriate for static native
integrations and reusable Tauri features, but adding or removing one changes the
host build.

Tauri sidecars are similarly declared as external binaries in the application
bundle. They can provide the generic extension runtime shipped with Shep, but a
new sidecar declaration cannot be added after packaging the application.

Runtime extensions therefore need a host-managed loading mechanism above
Tauri's plugin and sidecar facilities.

## Isolation levels

The design distinguishes three claims that should not be conflated:

1. Code isolation: implementation is hidden behind an internal module API.
2. Package isolation: the module is independently built and distributed.
3. Runtime isolation: the module has an independently controlled process or
   sandbox boundary.

This plan targets all three for installable extensions. Built-in modules may
remain at code isolation when their trust, lifecycle, and release cadence are
identical to the host.

## Stable-host constraint

The host can evolve internally, but the public extension surface must be
versioned and compatibility-tested. Extensions may depend on capabilities and
protocol versions, never on source paths, Zustand store shapes, Tauri command
names, database tables, or concrete Rust service types.

## Distribution assumption

The initial target should be directly distributed desktop builds for macOS,
Windows, and Linux. Store-distributed applications can impose additional limits
on downloaded executable code and must be assessed as separate release targets.
