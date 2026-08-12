import type {
  TerminalDriverId,
  TerminalPresentationProvider,
} from "@shipctl/module-api";

/**
 * Build-profile registry for terminal presentations.
 *
 * The registry is deliberately independent of the terminal store. A
 * descriptor selects a driver once; this class only resolves that choice and
 * rejects ambiguous module composition during startup.
 */
export class TerminalPresentationRegistry {
  readonly #providers = new Map<TerminalDriverId, TerminalPresentationProvider>();

  constructor(providers: readonly TerminalPresentationProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: TerminalPresentationProvider): void {
    if (this.#providers.has(provider.driverId)) {
      throw new Error(`Duplicate terminal presentation provider: ${provider.driverId}`);
    }
    this.#providers.set(provider.driverId, provider);
  }

  resolve(driverId: TerminalDriverId): TerminalPresentationProvider | null {
    return this.#providers.get(driverId) ?? null;
  }

  require(driverId: TerminalDriverId): TerminalPresentationProvider {
    const provider = this.resolve(driverId);
    if (!provider) throw new Error(`Terminal driver is not installed: ${driverId}`);
    return provider;
  }

  ids(): readonly TerminalDriverId[] {
    return [...this.#providers.keys()];
  }
}

export function terminalPresentationRegistry(
  modules: readonly object[],
): TerminalPresentationRegistry {
  return new TerminalPresentationRegistry(modules.flatMap((module) =>
    (module as { readonly terminalPresentations?: readonly TerminalPresentationProvider[] })
      .terminalPresentations ?? [],
  ));
}
