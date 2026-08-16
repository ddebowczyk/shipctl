export interface CordisFiber {
  readonly dispose: () => Promise<void>;
}

export interface CordisFiberHandle extends CordisFiber, PromiseLike<CordisFiber> {}

export type CordisCleanup = () => void | Promise<void>;

export interface CordisContext {
  readonly fiber: CordisFiber;
  effect(
    execute: () => void | CordisCleanup | Promise<void | CordisCleanup>,
    label?: string,
  ): CordisCleanup & PromiseLike<CordisCleanup>;
  get(name: string, strict?: boolean): unknown;
  plugin(plugin: {
    readonly name?: string;
    apply(context: CordisContext): unknown;
  }): CordisFiberHandle;
  provide(name: string, value?: unknown): CordisCleanup;
}

export const Context: {
  new (): CordisContext;
};
