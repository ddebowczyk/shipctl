import type { CommandContribution } from "../module/commands";
import type { ConfigurationContribution } from "../module/configuration";
import type {
  ModuleScheduledTask,
  SkillsProviderContribution,
} from "../module/module";
import type { PanelContribution } from "../module/panels";
import type {
  GlobalNavigationContribution,
  GlobalSurfaceContribution,
  ProjectActionContribution,
  ProjectFactsProviderContribution,
  ProjectImportContribution,
  ProjectLayoutContribution,
  ProjectNavigationContribution,
  SettingsContribution,
  SidebarContribution,
} from "../module/surfaces";
import type { TerminalPresentationProvider } from "../module/terminalHost";
import type { ModuleMessageContributions } from "./messages";
import type { SemanticOwnedLease } from "./semanticServices";

/** One activation-owned registration surface for one existing contribution family. */
export interface PluginContributionRegistry<Contribution> {
  register(contribution: Contribution): SemanticOwnedLease;
}

/**
 * The closed contribution taxonomy a plugin can register while it is active.
 *
 * These are registration ports, not a second catalogue: the trusted runtime
 * collects their leases and verifies their resulting declarations against the
 * artifact admission before it publishes the activation.
 */
export interface PluginContributionRegistries {
  readonly commands: PluginContributionRegistry<CommandContribution>;
  readonly configuration: PluginContributionRegistry<ConfigurationContribution>;
  readonly globalNavigation: PluginContributionRegistry<GlobalNavigationContribution>;
  readonly globalSurfaces: PluginContributionRegistry<GlobalSurfaceContribution>;
  readonly messages: PluginContributionRegistry<ModuleMessageContributions>;
  readonly panels: PluginContributionRegistry<PanelContribution>;
  readonly projectActions: PluginContributionRegistry<ProjectActionContribution>;
  readonly projectFacts: PluginContributionRegistry<ProjectFactsProviderContribution>;
  readonly projectImports: PluginContributionRegistry<ProjectImportContribution>;
  readonly projectLayouts: PluginContributionRegistry<ProjectLayoutContribution>;
  readonly projectNavigation: PluginContributionRegistry<ProjectNavigationContribution>;
  readonly scheduledTasks: PluginContributionRegistry<ModuleScheduledTask>;
  readonly settings: PluginContributionRegistry<SettingsContribution>;
  readonly sidebars: PluginContributionRegistry<SidebarContribution>;
  readonly skillsProviders: PluginContributionRegistry<SkillsProviderContribution>;
  readonly terminalPresentations: PluginContributionRegistry<TerminalPresentationProvider>;
}
