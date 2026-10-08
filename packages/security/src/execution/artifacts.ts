import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { EvidenceType, SecurityEvidenceItem } from '@audivra/contracts'
import type { CreateSecurityEvidenceInput } from '@audivra/database'
import type { RecordEvidenceInput } from '../capabilities/types.ts'
import { ExecutionError } from './failures.ts'
import type { ExecutionWorkspace } from './workspace.ts'

/*
 * Evidence registration for one execution. Before anything is stored it checks that the execution is
 * still running (ownership), that the evidence type is one the capability declared, that metadata is
 * small, and — for an artifact — that the file is a regular file inside this execution's workspace
 * and fits the remaining artifact budget. Provenance is added by the runtime, never by the capability.
 */

const MAX_METADATA_BYTES = 64 * 1024

export interface ArtifactRegistrarOptions {
  workspace: ExecutionWorkspace
  /** Artifact budget of the execution in bytes. */
  maxBytes: number
  /** Evidence types the capability declared in its registered metadata. */
  allowedTypes: readonly EvidenceType[]
  /** Persists one evidence item (provenance is filled in by the caller). */
  persist(input: EvidenceContent): Promise<SecurityEvidenceItem>
}

export type EvidenceContent = Omit<CreateSecurityEvidenceInput, 'provenance' | 'engagementId' | 'source'> & { sensitivity: 'normal' | 'sensitive' }

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export class ArtifactRegistrar {
  readonly registered: SecurityEvidenceItem[] = []
  #open = true
  #bytes = 0

  constructor(private readonly options: ArtifactRegistrarOptions) {}

  /** Bytes of artifacts registered so far. */
  get bytes(): number {
    return this.#bytes
  }

  /** No evidence is accepted after the work ended or was stopped. */
  close(): void {
    this.#open = false
  }

  async register(item: RecordEvidenceInput): Promise<SecurityEvidenceItem> {
    if (!this.#open) throw new ExecutionError('executor-failed', 'evidence.closed', 'Evidence can only be recorded while the execution is running')
    if (!this.options.allowedTypes.includes(item.type)) {
      throw new ExecutionError('artifact-limit', 'artifact.type-not-declared', `Evidence type ${item.type} is not declared by the capability`)
    }
    const metadataSize = Buffer.byteLength(JSON.stringify(item.metadata ?? {}), 'utf8')
    if (metadataSize > MAX_METADATA_BYTES) {
      throw new ExecutionError('artifact-limit', 'artifact.metadata-too-large', `Evidence metadata is ${metadataSize} bytes (limit ${MAX_METADATA_BYTES})`)
    }
    let artifactPath: string | null = null
    let artifact: { bytes: number; sha256: string } | null = null
    if (item.artifactPath) {
      const file = await this.options.workspace.artifactFile(item.artifactPath)
      if (this.#bytes + file.bytes > this.options.maxBytes) {
        throw new ExecutionError(
          'artifact-limit',
          'artifact.budget-exceeded',
          `Artifact ${file.relative} (${file.bytes} bytes) exceeds the execution's artifact budget (${this.#bytes} of ${this.options.maxBytes} bytes used)`,
        )
      }
      artifactPath = file.relative
      artifact = { bytes: file.bytes, sha256: await sha256File(file.absolute) }
    }
    if (!this.#open) throw new ExecutionError('executor-failed', 'evidence.closed', 'Evidence can only be recorded while the execution is running')
    const recorded = await this.options.persist({
      type: item.type,
      title: item.title,
      summary: item.summary,
      url: item.url ?? null,
      artifactPath,
      metadata: artifact ? { ...(item.metadata ?? {}), artifact } : (item.metadata ?? {}),
      sensitivity: item.sensitivity ?? 'normal',
    })
    if (artifact) this.#bytes += artifact.bytes
    this.registered.push(recorded)
    return recorded
  }
}
