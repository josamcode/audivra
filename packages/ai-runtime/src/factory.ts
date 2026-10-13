import { getConfig } from '@audivra/config'
import { ClaudeCliProvider } from './claude/provider.ts'
import type { AgentProvider } from './provider.ts'
import { ProviderRegistry } from './registry.ts'
import { ProviderRouter } from './router.ts'

/*
 * Builds the provider registry and router from centralized configuration. Everywhere in the product that
 * needs AI obtains a provider/router from here — never by constructing an adapter directly — so the set of
 * providers and the preferred one are a configuration concern, not scattered through the code.
 */

const additionalProviders: AgentProvider[] = []

/**
 * Test/E2E seam: a provider registered in addition to the shipped ones (the deterministic reasoning provider
 * in the E2E backend). Never called in production; it only ever adds providers, it cannot replace one.
 */
export function registerAdditionalProvider(provider: AgentProvider): void {
  if (!additionalProviders.some((p) => p.id === provider.id)) additionalProviders.push(provider)
}

/** The providers Audivra ships. Today: the Claude Code CLI adapter. A second adapter registers here. */
export function createProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry().register(new ClaudeCliProvider())
  for (const provider of additionalProviders) registry.register(provider)
  return registry
}

export function createProviderRouter(registry: ProviderRegistry = createProviderRegistry()): ProviderRouter {
  return new ProviderRouter({ registry, preferredProviderId: getConfig().AI_PROVIDER })
}

/**
 * The default provider for the existing Website Audit flows (unchanged behaviour): the configured
 * preferred provider if present, else the first registered. Centralizes what used to be
 * `new ClaudeCliProvider()` scattered across the worker.
 */
export function defaultAgentProvider(registry: ProviderRegistry = createProviderRegistry()): AgentProvider {
  const preferred = registry.get(getConfig().AI_PROVIDER)
  return preferred ?? registry.list()[0]!
}
