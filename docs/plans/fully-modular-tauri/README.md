# Fully modular Tauri extension architecture

Status: architectural proposal; not yet implemented.

## Purpose

This plan describes how Shep can evolve from a statically composed Tauri
application into a microkernel with independently developed, packaged,
installed, discovered, enabled, disabled, upgraded, and removed extensions.

The defining requirement is that installing or removing an extension must not
require rebuilding or repackaging the main Tauri application.

## Bottom line

Official Tauri plugins are useful build-time integrations, but they are not a
runtime extension system. Shep therefore needs a stable extension host of its
own. The signed Tauri application should contain the registry, verifier,
capability broker, lifecycle supervisor, protocol gateway, observability, and
host-rendered UI primitives. Extension implementations should execute behind a
process or WebAssembly boundary and communicate only through versioned host
contracts.

The recommended initial model is:

- out-of-process extensions for general native and TypeScript functionality;
- WebAssembly components for portable, constrained providers and processors;
- declarative host-rendered UI as the default presentation contract;
- isolated extension webviews only when a richer custom UI is necessary;
- no arbitrary native dynamic libraries or JavaScript injection into the main
  webview for third-party extensions.

## Chapters

1. [Goals and constraints](01-goals-and-constraints.md)
2. [Microkernel architecture](02-microkernel-architecture.md)
3. [Extension package and registry](03-extension-package-and-registry.md)
4. [Runtime isolation models](04-runtime-isolation-models.md)
5. [UI extension models](05-ui-extension-models.md)
6. [Protocol, capabilities, and planes](06-protocol-capabilities-and-planes.md)
7. [Lifecycle and package operations](07-lifecycle-install-update-disable-remove.md)
8. [Security, signing, and OS constraints](08-security-signing-and-os-constraints.md)
9. [Shep integration and extension SDK](09-shep-integration-and-sdk.md)
10. [Delivery roadmap](10-delivery-roadmap.md)
11. [Decisions, risks, and open questions](11-decisions-risks-open-questions.md)
12. [References](12-references.md)

## Architectural guardrail

Physical packaging is not sufficient isolation. A valid extension must have a
small typed public contract, private implementation and resources, one owner of
its mutable state, no imports from sibling implementations, explicit
permissions, and an independently controllable lifecycle.

The extension protocol must remain materially smaller and more stable than
Shep's internal APIs. Otherwise independently packaged modules would still
require coordinated host releases.
