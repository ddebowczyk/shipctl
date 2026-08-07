# Security, signing, and OS constraints

## Trust boundary

An extension is executable supply-chain input. Package discovery is not trust,
and installation is not authorization. The host must separately establish:

- package integrity;
- publisher identity and trust policy;
- host/runtime compatibility;
- user- or policy-approved capabilities;
- runtime isolation and resource limits;
- ongoing health and revocation status.

## Signing and verification

The package format should sign a canonical manifest containing hashes for every
file. Verification should support key rotation and revocation without silently
changing the identity of an existing publisher.

Development mode may allow locally trusted keys or explicit unpacked paths, but
must remain visibly distinct from production trust. A workspace must not be able
to enable development mode or add a trusted key.

## Capability enforcement

Extensions should receive opaque scoped handles or operation access, not raw
paths, credentials, database connections, Tauri handles, or unrestricted shell
execution. The broker validates each operation against the current grant, even
if the manifest requested it and installation previously approved it.

Permission changes should take effect without reinstalling the extension.
Revocation must cancel or invalidate existing leases where feasible.

## macOS

The Hardened Runtime protects against code injection and arbitrary dynamic
library loading. In-process native plugins can require aligned signatures or
weakening library validation, which enlarges the attack surface.

Out-of-process extension executables still require a deliberate signing,
notarization, quarantine, and Gatekeeper strategy. Downloaded executable code
also affects Mac App Store eligibility and must be assessed separately.

WASM and declarative UI avoid native library validation, but the host runtime
and package remain part of Shep's security boundary.

## Windows

Native executables should use Authenticode where production policy requires it.
All executable and library paths must be fully resolved to verified package
locations. Never depend on current-directory or ambient DLL search behavior.

Separate processes improve crash containment but are not a sandbox by default.
AppContainer or other process-isolation mechanisms can be evaluated for higher
threat tiers.

## Linux

Linux distribution formats and sandbox facilities differ. Shep needs its own
cross-platform package signature verification regardless of AppImage, Debian,
RPM, Flatpak, or other transport.

Flatpak and similar sandboxes may restrict starting downloaded executables or
accessing arbitrary paths. The release-target matrix must test extension
activation separately for every supported packaging format.

## Web content

Rich extension UI must use a restrictive Content Security Policy and a separate
authority boundary. Avoid remote scripts, broad `connect-src`, inline execution,
and direct Tauri API access. Treat extension-provided HTML and terminal output as
untrusted display data.

## Resource denial

The host needs limits for process count, memory where enforceable, CPU or WASM
fuel, operation concurrency, protocol message size, stream queue capacity,
filesystem volume, restart frequency, and log volume.

## Data and privacy

Extension telemetry must not record terminal contents, prompts, credentials, or
workspace files by default. Extension data should be namespaced and inspectable
enough to support export and explicit purge.
