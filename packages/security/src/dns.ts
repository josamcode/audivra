import { lookup } from 'node:dns/promises'
import { parseIp } from '@audivra/contracts'

/** Resolves a host name to every address it currently has (A and AAAA). Injectable for tests. */
export type Resolver = (host: string, signal?: AbortSignal) => Promise<string[]>

/** The operating system resolver (hosts file included), bounded by a timeout. */
export const systemResolver: Resolver = async (host, signal) => {
  if (parseIp(host)) return [parseIp(host)!.text]
  const timeout = AbortSignal.timeout(5000)
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
  const result = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => abort.addEventListener('abort', () => reject(new Error(`DNS lookup of ${host} was aborted or timed out`)), { once: true })),
  ])
  return [...new Set(result.map((entry) => entry.address))]
}
