export type ModuleTaskSchedule =
  | { readonly kind: "startup" }
  | { readonly kind: "delay"; readonly delayMs: number }
  | { readonly kind: "interval"; readonly intervalMs: number };
