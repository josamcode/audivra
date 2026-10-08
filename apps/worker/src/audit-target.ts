import type { AuditTarget } from '@audivra/ai-runtime'
import { getTemplate } from '@audivra/contracts'
import type { AuditRow } from '@audivra/database'

/** What the AI roles are told about the audit: the site, the client label and the audit focus. */
export function target(audit: AuditRow): AuditTarget {
  return {
    id: audit.id,
    url: audit.normalizedUrl,
    domain: audit.domain,
    clientName: audit.clientName,
    template: audit.templateKey ? getTemplate(audit.templateKey) : null,
  }
}
