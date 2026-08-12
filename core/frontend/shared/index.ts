// Cross-capability building blocks. A file earns a place here only when more
// than one capability already imports it.
//
// JSX-free by design: the node --test lanes run through Node's type stripping,
// which handles .ts but not .tsx. The React surface lives in ./views.ts.
export * from "./useNoticeStore.ts";
export * from "./runtimeDiagnostics.ts";
export * from "./useUIStore.ts";
export * from "./a11y.ts";
export * from "./globalSurfaceIds.ts";
