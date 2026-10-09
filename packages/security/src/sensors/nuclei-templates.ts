/*
 * Audivra's reviewed Nuclei templates. Nuclei is run with ONLY these templates (`-templates <dir>`),
 * never the image's bundled public set and never a user- or model-supplied path. They are shipped here, in
 * version control, and reviewed like any code asset. They are deliberately passive, info-severity checks
 * (a single GET of the target root): each match is a *signal to review* recorded as a `web-signal`
 * observation, never a verified vulnerability. A tool/template severity never becomes Audivra's severity.
 */
export const AUDIVRA_NUCLEI_TEMPLATES: Record<string, string> = {
  'audivra-missing-hsts.yaml': `id: audivra-missing-hsts
info:
  name: Missing Strict-Transport-Security header
  author: audivra
  severity: info
  tags: audivra,misconfig,headers
  description: The response did not include a Strict-Transport-Security header. A passive info signal to review, not a confirmed issue.
http:
  - method: GET
    path:
      - "{{BaseURL}}/"
    matchers:
      - type: word
        part: header
        negative: true
        condition: or
        words:
          - "Strict-Transport-Security"
          - "strict-transport-security"
`,
  'audivra-server-banner.yaml': `id: audivra-server-banner
info:
  name: Server banner disclosed
  author: audivra
  severity: info
  tags: audivra,tech
  description: The server disclosed a Server response header. A passive info signal (technology/version exposure) to review.
http:
  - method: GET
    path:
      - "{{BaseURL}}/"
    matchers:
      - type: regex
        part: header
        regex:
          - "(?i)server: .+"
    extractors:
      - type: regex
        part: header
        group: 1
        regex:
          - "(?i)server: (.+)"
`,
}
