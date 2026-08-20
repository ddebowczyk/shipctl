import type {
  CommandContribution,
  ConfigurationContribution,
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ModuleActivationIdentity,
  ModuleMessageContributions,
  ModuleScheduledTask,
  PanelContribution,
  PluginContributionFamily,
  PluginContributionInspection,
  PluginContributionRegistries,
  ProjectActionContribution,
  ProjectFactsProviderContribution,
  ProjectImportContribution,
  ProjectLayoutContribution,
  ProjectNavigationContribution,
  SemanticCleanup,
  SemanticOwnedLease,
  SettingsContribution,
  SidebarContribution,
  SkillsProviderContribution,
  TerminalPresentationProvider,
} from "@shipctl/module-api";

export interface RegisteredPluginContributions {
  readonly commands: readonly CommandContribution[];
  readonly configuration: readonly ConfigurationContribution[];
  readonly globalNavigation: readonly GlobalNavigationContribution[];
  readonly globalSurfaces: readonly GlobalSurfaceContribution[];
  readonly messages: readonly ModuleMessageContributions[];
  readonly panels: readonly PanelContribution[];
  readonly projectActions: readonly ProjectActionContribution[];
  readonly projectFacts: readonly ProjectFactsProviderContribution[];
  readonly projectImports: readonly ProjectImportContribution[];
  readonly projectLayouts: readonly ProjectLayoutContribution[];
  readonly projectNavigation: readonly ProjectNavigationContribution[];
  readonly scheduledTasks: readonly ModuleScheduledTask[];
  readonly settings: readonly SettingsContribution[];
  readonly sidebars: readonly SidebarContribution[];
  readonly skillsProviders: readonly SkillsProviderContribution[];
  readonly terminalPresentations: readonly TerminalPresentationProvider[];
}

export interface PluginContributionCollector {
  readonly registries: PluginContributionRegistries;
  inspect(): readonly PluginContributionInspection[];
  snapshot(): RegisteredPluginContributions;
}

type OwnedContribution = {
  readonly id: string;
  readonly moduleId: string;
};

type ContributionStore<Contribution> = {
  readonly family: PluginContributionFamily;
  readonly entries: Contribution[];
  readonly ids: Set<string>;
  readonly id: (contribution: Contribution) => string;
  readonly owned: (contribution: Contribution) => OwnedContribution | null;
};

function freezeEntries<Contribution>(entries: readonly Contribution[]): readonly Contribution[] {
  return Object.freeze([...entries]);
}

function contributionStore<Contribution>(
  family: PluginContributionFamily,
  id: (contribution: Contribution) => string,
  owned: (contribution: Contribution) => OwnedContribution | null,
): ContributionStore<Contribution> {
  return { family, entries: [], ids: new Set(), id, owned };
}

/**
 * Private runtime collector behind the public activation registration ports.
 * Registrations acquire an activation-owned lease, so failed candidates and
 * ordinary deactivation remove every executable contribution uniformly.
 */
export function createPluginContributionCollector(
  identity: ModuleActivationIdentity,
  own: (cleanup: SemanticCleanup) => SemanticOwnedLease,
): PluginContributionCollector {
  const commands = contributionStore("command", (value: CommandContribution) => value.id, (value) => value);
  const configuration = contributionStore(
    "configuration",
    (value: ConfigurationContribution) => value.id,
    (value) => value,
  );
  const globalNavigation = contributionStore(
    "global-navigation",
    (value: GlobalNavigationContribution) => value.id,
    (value) => value,
  );
  const globalSurfaces = contributionStore(
    "global-surface",
    (value: GlobalSurfaceContribution) => value.id,
    (value) => value,
  );
  const messages = contributionStore<ModuleMessageContributions>(
    "message-graph",
    () => `${identity.moduleId}.messages`,
    () => null,
  );
  const panels = contributionStore("panel", (value: PanelContribution) => value.id, (value) => value);
  const projectActions = contributionStore(
    "project-action",
    (value: ProjectActionContribution) => value.id,
    (value) => value,
  );
  const projectFacts = contributionStore(
    "project-facts",
    (value: ProjectFactsProviderContribution) => value.id,
    (value) => value,
  );
  const projectImports = contributionStore(
    "project-import",
    (value: ProjectImportContribution) => value.id,
    (value) => value,
  );
  const projectLayouts = contributionStore(
    "project-layout",
    (value: ProjectLayoutContribution) => value.id,
    (value) => value,
  );
  const projectNavigation = contributionStore(
    "project-navigation",
    (value: ProjectNavigationContribution) => value.id,
    (value) => value,
  );
  const scheduledTasks = contributionStore(
    "scheduled-task",
    (value: ModuleScheduledTask) => value.id,
    (value) => value,
  );
  const settings = contributionStore(
    "settings",
    (value: SettingsContribution) => value.id,
    (value) => value,
  );
  const sidebars = contributionStore("sidebar", (value: SidebarContribution) => value.id, (value) => value);
  const skillsProviders = contributionStore(
    "skills-provider",
    (value: SkillsProviderContribution) => value.id,
    (value) => value,
  );
  const terminalPresentations = contributionStore(
    "terminal-presentation",
    (value: TerminalPresentationProvider) => value.driverId,
    (value) => ({ id: value.driverId, moduleId: value.moduleId }),
  );

  const register = <Contribution>(store: ContributionStore<Contribution>, contribution: Contribution) => {
    const contributionId = store.id(contribution);
    if (!contributionId) {
      throw new Error(`${store.family} contribution must have a stable ID`);
    }
    const owner = store.owned(contribution);
    if (owner !== null && owner.moduleId !== identity.moduleId) {
      throw new Error(
        `${store.family} contribution ${contributionId} belongs to ${owner.moduleId}, not ${identity.moduleId}`,
      );
    }
    if (store.ids.has(contributionId)) {
      throw new Error(`Duplicate plugin contribution: ${store.family}:${contributionId}`);
    }
    store.ids.add(contributionId);
    store.entries.push(contribution);
    try {
      return own(() => {
        store.ids.delete(contributionId);
        const index = store.entries.indexOf(contribution);
        if (index !== -1) store.entries.splice(index, 1);
      });
    } catch (error) {
      store.ids.delete(contributionId);
      const index = store.entries.indexOf(contribution);
      if (index !== -1) store.entries.splice(index, 1);
      throw error;
    }
  };

  const registries: PluginContributionRegistries = Object.freeze({
    commands: Object.freeze({ register: (value: CommandContribution) => register(commands, value) }),
    configuration: Object.freeze({
      register: (value: ConfigurationContribution) => register(configuration, value),
    }),
    globalNavigation: Object.freeze({
      register: (value: GlobalNavigationContribution) => register(globalNavigation, value),
    }),
    globalSurfaces: Object.freeze({
      register: (value: GlobalSurfaceContribution) => register(globalSurfaces, value),
    }),
    messages: Object.freeze({
      register: (value: ModuleMessageContributions) => register(messages, value),
    }),
    panels: Object.freeze({ register: (value: PanelContribution) => register(panels, value) }),
    projectActions: Object.freeze({
      register: (value: ProjectActionContribution) => register(projectActions, value),
    }),
    projectFacts: Object.freeze({
      register: (value: ProjectFactsProviderContribution) => register(projectFacts, value),
    }),
    projectImports: Object.freeze({
      register: (value: ProjectImportContribution) => register(projectImports, value),
    }),
    projectLayouts: Object.freeze({
      register: (value: ProjectLayoutContribution) => register(projectLayouts, value),
    }),
    projectNavigation: Object.freeze({
      register: (value: ProjectNavigationContribution) => register(projectNavigation, value),
    }),
    scheduledTasks: Object.freeze({
      register: (value: ModuleScheduledTask) => register(scheduledTasks, value),
    }),
    settings: Object.freeze({ register: (value: SettingsContribution) => register(settings, value) }),
    sidebars: Object.freeze({ register: (value: SidebarContribution) => register(sidebars, value) }),
    skillsProviders: Object.freeze({
      register: (value: SkillsProviderContribution) => register(skillsProviders, value),
    }),
    terminalPresentations: Object.freeze({
      register: (value: TerminalPresentationProvider) => register(terminalPresentations, value),
    }),
  });

  const inspectStore = <Contribution>(
    store: ContributionStore<Contribution>,
  ): readonly PluginContributionInspection[] => store.entries.map((contribution) => ({
    ownerActivationId: identity.activationId,
    moduleId: identity.moduleId,
    family: store.family,
    id: store.id(contribution),
  }));

  return Object.freeze({
    registries,
    inspect: () => Object.freeze([
      ...inspectStore(commands),
      ...inspectStore(configuration),
      ...inspectStore(globalNavigation),
      ...inspectStore(globalSurfaces),
      ...inspectStore(messages),
      ...inspectStore(panels),
      ...inspectStore(projectActions),
      ...inspectStore(projectFacts),
      ...inspectStore(projectImports),
      ...inspectStore(projectLayouts),
      ...inspectStore(projectNavigation),
      ...inspectStore(scheduledTasks),
      ...inspectStore(settings),
      ...inspectStore(sidebars),
      ...inspectStore(skillsProviders),
      ...inspectStore(terminalPresentations),
    ]),
    snapshot: () => Object.freeze({
      commands: freezeEntries(commands.entries),
      configuration: freezeEntries(configuration.entries),
      globalNavigation: freezeEntries(globalNavigation.entries),
      globalSurfaces: freezeEntries(globalSurfaces.entries),
      messages: freezeEntries(messages.entries),
      panels: freezeEntries(panels.entries),
      projectActions: freezeEntries(projectActions.entries),
      projectFacts: freezeEntries(projectFacts.entries),
      projectImports: freezeEntries(projectImports.entries),
      projectLayouts: freezeEntries(projectLayouts.entries),
      projectNavigation: freezeEntries(projectNavigation.entries),
      scheduledTasks: freezeEntries(scheduledTasks.entries),
      settings: freezeEntries(settings.entries),
      sidebars: freezeEntries(sidebars.entries),
      skillsProviders: freezeEntries(skillsProviders.entries),
      terminalPresentations: freezeEntries(terminalPresentations.entries),
    }),
  });
}
