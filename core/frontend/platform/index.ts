// The host's boundary with the outside world: the Tauri IPC bindings, the
// shapes those bindings exchange with Rust, and error extraction for them.
// Capabilities import this entry point; nothing imports its files directly.
//
// Extensions are explicit because these are runtime re-exports: the node --test
// lanes resolve them through Node's ESM resolver, which does not extension-guess.
export * from "./tauri.ts";
export * from "./types.ts";
export * from "./errors.ts";
