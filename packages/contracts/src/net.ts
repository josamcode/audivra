/**
 * Platform-neutral network address helpers (no Node APIs: the web app validates scope input with them
 * too). Used by the security scope manifest schema and the scope engine.
 *
 * Addresses are parsed strictly and compared numerically, so textual tricks (leading zeros, IPv4-mapped
 * IPv6, compressed forms) never let one address pass for another.
 */

export type IpFamily = 4 | 6

export interface ParsedIp {
  family: IpFamily
  value: bigint
  /** Canonical text: dotted quad, or RFC 5952 compressed lower-case IPv6 (no brackets). */
  text: string
}

export interface Cidr {
  family: IpFamily
  /** Network address (host bits cleared). */
  network: bigint
  prefix: number
  text: string
}

const V4_BITS = 32
const V6_BITS = 128

export function parseIPv4(input: string): bigint | null {
  const parts = input.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    // Strict decimal octets: no empty parts, no leading zeros (which some stacks read as octal), no signs.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

export function parseIPv6(input: string): bigint | null {
  if (!input || input.includes('%')) return null // zone IDs are host-local and never in scope
  let text = input.toLowerCase()
  let tail: bigint[] = []
  if (text.includes('.')) {
    // Embedded IPv4 in the last 32 bits (e.g. ::ffff:192.0.2.1).
    const lastColon = text.lastIndexOf(':')
    const v4 = parseIPv4(text.slice(lastColon + 1))
    if (v4 === null) return null
    tail = [(v4 >> 16n) & 0xffffn, v4 & 0xffffn]
    // Keep a "::" that directly precedes the IPv4 part; drop a single separating colon.
    text = text.slice(0, lastColon + 1)
    if (!text.endsWith('::')) text = text.slice(0, -1)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part: string): bigint[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    const out: bigint[] = []
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      out.push(BigInt(`0x${group}`))
    }
    return out
  }
  const head = parseGroups(halves[0] ?? '')
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? '') : []
  if (!head || !rest) return null
  const explicit = head.length + rest.length + tail.length
  let groups: bigint[]
  if (halves.length === 2) {
    if (explicit > 7) return null
    groups = [...head, ...Array<bigint>(8 - explicit).fill(0n), ...rest, ...tail]
  } else {
    if (explicit !== 8) return null
    groups = [...head, ...tail]
  }
  return groups.reduce((acc, group) => (acc << 16n) | group, 0n)
}

export function formatIp(value: bigint, family: IpFamily): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.')
  }
  const groups = Array.from({ length: 8 }, (_, i) => (value >> BigInt((7 - i) * 16)) & 0xffffn)
  // RFC 5952: compress the longest run (≥ 2) of zero groups, the first one on ties.
  let bestStart = -1
  let bestLength = 0
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0n) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0n) j++
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i
      bestLength = j - i
    }
    i = j
  }
  const hex = groups.map((g) => g.toString(16))
  if (bestStart < 0) return hex.join(':')
  const left = hex.slice(0, bestStart).join(':')
  const right = hex.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}

/** Parses an IPv4 or IPv6 literal (IPv6 may be bracketed). Returns null for anything else. */
export function parseIp(input: string): ParsedIp | null {
  const raw = input.trim()
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  const v4 = parseIPv4(unbracketed)
  if (v4 !== null) return { family: 4, value: v4, text: formatIp(v4, 4) }
  const v6 = parseIPv6(unbracketed)
  if (v6 !== null) return { family: 6, value: v6, text: formatIp(v6, 6) }
  return null
}

/** IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address for every scope decision. */
export function unmapIp(ip: ParsedIp): ParsedIp {
  if (ip.family === 6 && ip.value >> 32n === 0xffffn) {
    const v4 = ip.value & 0xffffffffn
    return { family: 4, value: v4, text: formatIp(v4, 4) }
  }
  return ip
}

export function parseCidr(input: string): Cidr | null {
  const [address, prefixText, extra] = input.trim().split('/')
  if (extra !== undefined || !address || prefixText === undefined || !/^\d{1,3}$/.test(prefixText)) return null
  const ip = parseIp(address)
  if (!ip) return null
  const bits = ip.family === 4 ? V4_BITS : V6_BITS
  const prefix = Number(prefixText)
  if (prefix > bits) return null
  const hostBits = BigInt(bits - prefix)
  const network = (ip.value >> hostBits) << hostBits
  return { family: ip.family, network, prefix, text: `${formatIp(network, ip.family)}/${prefix}` }
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  const candidate = unmapIp(ip)
  const block = cidr.family === 6 && cidr.network >> 32n === 0xffffn && cidr.prefix >= 96
    ? { family: 4 as const, network: cidr.network & 0xffffffffn, prefix: cidr.prefix - 96 }
    : cidr
  if (candidate.family !== block.family) return false
  const bits = block.family === 4 ? V4_BITS : V6_BITS
  const hostBits = BigInt(bits - block.prefix)
  return candidate.value >> hostBits === block.network >> hostBits
}

/** Number of addresses in a block. */
export function cidrSize(cidr: Cidr): bigint {
  return 1n << BigInt((cidr.family === 4 ? V4_BITS : V6_BITS) - cidr.prefix)
}

export const ADDRESS_CATEGORIES = [
  'public',
  'loopback',
  'private',
  'link-local',
  'unique-local',
  'shared',
  'unspecified',
  'multicast',
  'documentation',
  'reserved',
] as const
export type AddressCategory = (typeof ADDRESS_CATEGORIES)[number]

const V4_RANGES: [string, AddressCategory][] = [
  ['0.0.0.0/8', 'unspecified'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'shared'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'reserved'],
  ['192.0.2.0/24', 'documentation'],
  ['192.168.0.0/16', 'private'],
  ['198.18.0.0/15', 'reserved'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
]

const V6_RANGES: [string, AddressCategory][] = [
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['::/96', 'reserved'],
  ['fc00::/7', 'unique-local'],
  ['fe80::/10', 'link-local'],
  ['ff00::/8', 'multicast'],
  ['2001:db8::/32', 'documentation'],
]

const parsedRanges = (ranges: [string, AddressCategory][]) =>
  ranges.map(([text, category]) => ({ cidr: parseCidr(text)!, category }))
const V4_TABLE = parsedRanges(V4_RANGES)
const V6_TABLE = parsedRanges(V6_RANGES)
const NAT64 = parseCidr('64:ff9b::/96')!
const SIX_TO_FOUR = parseCidr('2002::/16')!

/**
 * Category of an address. Translation prefixes (IPv4-mapped, NAT64, 6to4) are classified by the IPv4
 * address they carry, so a private address cannot hide inside an IPv6 literal.
 */
export function classifyIp(input: ParsedIp): AddressCategory {
  const ip = unmapIp(input)
  if (ip.family === 6) {
    if (cidrContains(NAT64, ip)) return classifyIp({ family: 4, value: ip.value & 0xffffffffn, text: '' })
    if (cidrContains(SIX_TO_FOUR, ip)) return classifyIp({ family: 4, value: (ip.value >> 80n) & 0xffffffffn, text: '' })
  }
  const table = ip.family === 4 ? V4_TABLE : V6_TABLE
  // Most specific match wins (::/128 and ::1/128 before ::/96).
  let best: { prefix: number; category: AddressCategory } | null = null
  for (const range of table) {
    if (cidrContains(range.cidr, ip) && (!best || range.cidr.prefix > best.prefix)) {
      best = { prefix: range.cidr.prefix, category: range.category }
    }
  }
  return best?.category ?? 'public'
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * Normalizes a DNS host name: lower-case, IDN → punycode (when URL is available), no trailing dot.
 * Returns null for anything that is not a syntactically valid name (wildcards, spaces, URLs, IP literals).
 */
export function normalizeHostname(input: string): string | null {
  let host = input.trim().toLowerCase()
  if (!host || host.length > 253 || host.includes('*')) return null
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (parseIp(host)) return null
  if (/[^\x21-\x7e]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname
    } catch {
      return null
    }
  }
  const labels = host.split('.')
  if (!labels.every((label) => LABEL.test(label))) return null
  // A purely numeric last label would make the name parse as an IPv4 address in URLs.
  if (/^\d+$/.test(labels.at(-1) ?? '')) return null
  return host
}

/** `localhost` and names under `.localhost` always resolve to the local machine (RFC 6761). */
export function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost')
}

/** True when `host` equals `parent` or is a subdomain of it. */
export function isSameOrSubdomain(host: string, parent: string): boolean {
  return host === parent || host.endsWith(`.${parent}`)
}
