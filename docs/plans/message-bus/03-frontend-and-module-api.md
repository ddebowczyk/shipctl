# Frontend and module API

## Layering

Add platform transport in `core/frontend/platform/runtimeMessages.ts`. It is
the only frontend layer in this capability that imports Tauri APIs.

Add host ownership in `core/frontend/host/`:

- `messageBusBridge.ts` opens, closes, and reconnects the Tauri channel;
- `moduleMessageContext.ts` builds a grant-bound facade for one activation;
- supervisor integration stages registrations and publishes route changes;
- runtime snapshots expose message contributions and health.

Add pure public contracts in `modules/api/frontend/src/messages.ts` and export
them from `@shipctl/module-api`. No API type imports host implementation code.

## Module-facing API

Expose typed references rather than free-form invocation:

```ts
export interface MessageRef<Payload> {
  readonly id: string;
  readonly version: number;
}

export interface DirectedChannel<Payload> {
  readonly id: string;
  readonly message: MessageRef<Payload>;
}

export interface BroadcastTopic<Payload> {
  readonly id: string;
  readonly message: MessageRef<Payload>;
}

export interface ModuleMessages {
  send<Payload>(
    channel: DirectedChannel<Payload>,
    payload: Payload,
  ): Promise<DeliveryReceipt>;

  publish<Payload>(
    topic: BroadcastTopic<Payload>,
    payload: Payload,
  ): Promise<PublishReceipt>;
}
```

The host supplies `ModuleMessages` during activation. Its authority is already
bound to the selected module artifact and activation generation; there is no
`moduleId` argument or generic Tauri command escape hatch.

TypeScript generics improve authoring, but Rust schema validation remains the
runtime authority. Shared golden fixtures prove that Rust and TypeScript agree
on wire shapes.

## Declarative handlers

Extend the module descriptor with declarative message contributions:

```ts
messages: {
  handles: [handleAgentWakeup],
  subscribes: [observeTerminalAvailability],
}
```

Definitions carry stable endpoint references, schemas, capacities, and handler
functions. The host registers and disposes them. Modules do not call a global
`subscribe()` during `activate()`, which prevents orphan listeners and makes
preflight possible before live replacement.

Explicit capability ports use similarly declarative request handlers and
typed client stubs. Their replies use the bus runtime internally but preserve
the port's request/response contract.

## Frontend delivery

The bridge dispatches a frame only to the owner registration in the route
snapshot named by the frame. It validates activation generation before calling
the handler. A failure in one handler becomes a structured result and does not
break the channel reader or another module.

React components consume capability stores or ports; they do not subscribe to
the raw bridge for derived state. Lifecycle listeners are installed and torn
down by the host, consistent with the repository's React rules.

## Migration targets

- Replace direct `listen()` calls in modules with declared subscriptions.
- Replace the singleton `MODULE_HOST_SERVICES` with activation-scoped services.
- Enrich `moduleRuntimeSnapshot` with contracts, routes, grants, and health.
- Keep dedicated PTY channels intact and expose terminal lifecycle messages
  separately.
- Remove browser-timer scheduling from `moduleComposition` after the scheduler
  service is proven.
