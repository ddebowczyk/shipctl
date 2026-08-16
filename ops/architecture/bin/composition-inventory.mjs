import { createServer } from "vite";

function contribution(contribution, fields = []) {
  const record = {
    id: String(contribution.id),
    module_id: String(contribution.moduleId),
  };
  for (const [source, target = source] of fields) {
    const value = contribution[source];
    if (value !== undefined) record[target] = value;
  }
  return record;
}

function contributions(module, field, fields = []) {
  return (module[field] ?? []).map((item) => contribution(item, fields));
}

function messageReference(value) {
  const message = value?.message ?? value?.topic?.message ?? value?.channel?.message;
  return message ? { id: String(message.id), version: message.version } : null;
}

function messageContribution(value, route) {
  const endpoint = value[route];
  return {
    id: String(endpoint.id),
    message: messageReference(value),
    ...(value.capacity === undefined ? {} : { capacity: value.capacity }),
    ...(value.requiredGrant === undefined ? {} : { required_grant: value.requiredGrant }),
    ...(value.schedulerAllowed === undefined ? {} : { scheduler_allowed: value.schedulerAllowed }),
  };
}

export function normalizeLegacyComposition(modules) {
  return modules.map((module) => ({
    id: String(module.id),
    version: module.version,
    commands: contributions(module, "commands", [["label"], ["shortcut"]]),
    panels: contributions(module, "panels", [
      ["scope"],
      ["label"],
      ["singleton"],
      ["order"],
      ["shortcut"],
    ]),
    global_surfaces: contributions(module, "globalSurfaces"),
    global_navigation: contributions(module, "globalNavigation", [
      ["surfaceId", "surface_id"],
      ["label"],
      ["order"],
    ]),
    sidebar: contributions(module, "sidebar", [
      ["surfaceId", "surface_id"],
      ["order"],
    ]),
    project_navigation: contributions(module, "projectNavigation", [
      ["panelId", "panel_id"],
      ["order"],
    ]),
    project_layout: contributions(module, "projectLayout", [["slot"], ["order"]]),
    project_actions: contributions(module, "projectActions", [["order"]]),
    project_facts_provider: module.projectFactsProvider
      ? contribution(module.projectFactsProvider)
      : null,
    project_import: module.projectImport ? contribution(module.projectImport) : null,
    settings: contributions(module, "settings", [["slot"], ["order"]]),
    skills_provider: module.skillsProvider ? contribution(module.skillsProvider) : null,
    scheduled_tasks: (module.scheduledTasks ?? []).map((task) => ({
      ...contribution(task),
      schedule: task.schedule,
    })),
    messages: {
      provides: (module.messages?.provides ?? []).map((item) => ({
        message: messageReference(item),
      })),
      handles: (module.messages?.handles ?? []).map((item) =>
        messageContribution(item, "channel")),
      publishes: (module.messages?.publishes ?? []).map((item) =>
        messageContribution(item, "topic")),
      subscribes: (module.messages?.subscribes ?? []).map((item) =>
        messageContribution(item, "topic")),
    },
    terminal_presentations: (module.terminalPresentations ?? []).map((item) => ({
      driver_id: String(item.driverId),
    })),
    lifecycle: Object.keys(module.projectLifecycle ?? {}).sort(),
    activates: typeof module.activate === "function",
    prepares_shutdown: typeof module.beforeShutdown === "function",
  }));
}

export async function inspectLegacyComposition(repositoryRoot) {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const { ENABLED_MODULES } = await vite.ssrLoadModule(
      "/core/frontend/host/enabledModules.ts",
    );
    return normalizeLegacyComposition(ENABLED_MODULES);
  } finally {
    await vite.close();
  }
}
