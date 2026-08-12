import { Suspense } from "react";
import type {
  ModuleHostServices,
  TerminalHostDescriptor,
  TerminalHostPort,
} from "@shipctl/module-api";

import type { TerminalPresentationRegistry } from "./terminalPresentationRegistry.ts";

export interface TerminalSlotProps {
  readonly descriptor: TerminalHostDescriptor;
  readonly host: TerminalHostPort;
  readonly registry: TerminalPresentationRegistry;
  readonly visible: boolean;
  readonly services: Pick<
    ModuleHostServices,
    "notices" | "externalLinks" | "terminalPresentation"
  >;
}

/** Generic terminal chrome. It never imports a terminal implementation. */
export function TerminalSlot({ descriptor, host, registry, visible, services }: TerminalSlotProps) {
  const provider = registry.resolve(descriptor.driverId);
  if (!provider) {
    return (
      <div className="terminal-unavailable" role="alert">
        Terminal driver {descriptor.driverId} is not installed.
      </div>
    );
  }
  const Presentation = provider.Presentation;
  return (
    <Suspense fallback={<div className="terminal-empty">Loading terminal…</div>}>
      <Presentation
        descriptor={descriptor}
        host={host}
        services={services}
        terminalId={descriptor.id}
        visible={visible}
      />
    </Suspense>
  );
}
