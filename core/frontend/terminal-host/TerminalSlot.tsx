import { Suspense } from "react";
import type {
  ModuleActivationContext,
  ModuleId,
  ModuleHostServices,
  TerminalHostDescriptor,
} from "@shipctl/module-api";

import type { TerminalPresentationRegistry } from "./terminalPresentationRegistry.ts";

export interface TerminalSlotProps {
  readonly descriptor: TerminalHostDescriptor;
  readonly registry: TerminalPresentationRegistry;
  readonly moduleActivations: ReadonlyMap<ModuleId, ModuleActivationContext>;
  readonly visible: boolean;
  readonly services: Pick<
    ModuleHostServices,
    "notices" | "externalLinks" | "terminalPresentation"
  >;
}

/** Generic terminal chrome. It never imports a terminal implementation. */
export function TerminalSlot({
  descriptor,
  registry,
  moduleActivations,
  visible,
  services,
}: TerminalSlotProps) {
  const provider = registry.resolve(descriptor.driverId);
  if (!provider) {
    return (
      <div className="terminal-unavailable" role="alert">
        Terminal driver {descriptor.driverId} is not installed.
      </div>
    );
  }
  const activation = moduleActivations.get(provider.moduleId);
  const missingService = provider.requiredServices?.find(
    (service) => !activation?.services.has(service),
  );
  if (!activation || activation.disposed || missingService) {
    return (
      <div className="terminal-unavailable" role="alert">
        Terminal driver {descriptor.driverId} has no active capability binding.
      </div>
    );
  }
  const Presentation = provider.Presentation;
  return (
    <Suspense fallback={<div className="terminal-empty">Loading terminal…</div>}>
      <Presentation
        activation={activation}
        descriptor={descriptor}
        services={services}
        terminalId={descriptor.id}
        visible={visible}
      />
    </Suspense>
  );
}
