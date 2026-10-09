import type { ProviderHealth } from '@audivra/contracts'
import type { AgentProvider } from './provider.ts'

/*
 * The set of AI providers Audivra knows about. The security and audit domains obtain a provider from the
 * registry/router — never by constructing a specific adapter — so swapping or adding a provider is a
 * configuration/registration change, not a domain change.
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, AgentProvider>()
  readonly #order: string[] = []

  register(provider: AgentProvider): this {
    if (this.#providers.has(provider.id)) throw new Error(`Provider ${provider.id} is already registered`)
    this.#providers.set(provider.id, provider)
    this.#order.push(provider.id)
    return this
  }

  get(id: string): AgentProvider | undefined {
    return this.#providers.get(id)
  }

  has(id: string): boolean {
    return this.#providers.has(id)
  }

  /** Providers in registration order. */
  list(): AgentProvider[] {
    return this.#order.map((id) => this.#providers.get(id)!)
  }

  /** Health of every registered provider (for the System view / health route). */
  async health(): Promise<ProviderHealth[]> {
    return Promise.all(this.list().map((p) => p.health()))
  }
}
