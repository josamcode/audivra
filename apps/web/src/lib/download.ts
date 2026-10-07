import { toast } from 'sonner'

function filenameFrom(response: Response, fallback: string): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  return match?.[1] ? decodeURIComponent(match[1]) : fallback
}

const inFlight = new Set<string>()

/**
 * Downloads a generated file (exports, rendered visuals) with visible progress. Exports are produced
 * on demand by the API (a PDF takes a few seconds), so a plain link would look unresponsive.
 */
export async function downloadFile(url: string, fallbackName: string, label: string): Promise<void> {
  if (inFlight.has(url)) return
  inFlight.add(url)
  const id = toast.loading(`Preparing ${label}…`)
  try {
    const response = await fetch(url)
    if (!response.ok) {
      let message = `Request failed (${response.status})`
      try {
        const body = (await response.json()) as { error?: string }
        if (body.error) message = body.error
      } catch {
        // non-JSON error body
      }
      throw new Error(message)
    }
    const blob = await response.blob()
    const name = filenameFrom(response, fallbackName)
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(href), 30_000)
    toast.success('Download ready', { id, description: name })
  } catch (error) {
    const message =
      error instanceof TypeError
        ? 'Cannot reach the Audivra API. Is the server running?'
        : error instanceof Error
          ? error.message
          : String(error)
    toast.error(`Could not prepare ${label}`, { id, description: message })
  } finally {
    inFlight.delete(url)
  }
}
