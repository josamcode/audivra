/*
 * Audivra's reviewed Semgrep ruleset. Semgrep runs with NO network (its runtime has no egress at all), so
 * its rules are not fetched from the Semgrep registry — they are shipped here, in version control, and
 * reviewed like any other code asset. A capability, a request or a model can never supply or alter them.
 *
 * These are deliberately small, conservative patterns. A Semgrep match is a *signal* recorded as a
 * `source-finding` observation — never a verified vulnerability. Verification and correlation happen in a
 * later layer.
 */
export const AUDIVRA_SEMGREP_RULES = `rules:
  - id: audivra.js.eval-use
    languages: [javascript, typescript]
    severity: WARNING
    message: >-
      Use of eval() executes a string as code. A signal to review for untrusted input, not a confirmed
      vulnerability.
    patterns:
      - pattern: eval(...)
  - id: audivra.js.document-write
    languages: [javascript, typescript]
    severity: WARNING
    message: >-
      document.write() with dynamic content is a DOM-XSS signal. A signal to review, not a confirmed
      vulnerability.
    patterns:
      - pattern: document.write(...)
  - id: audivra.js.child-process-exec
    languages: [javascript, typescript]
    severity: ERROR
    message: >-
      child_process.exec() runs a shell command. With a dynamic command string this is a command-injection
      signal to review.
    patterns:
      - pattern-either:
          - pattern: child_process.exec(...)
          - pattern: cp.exec(...)
          - pattern: exec($CMD, ...)
  - id: audivra.secrets.hardcoded-credential
    languages: [generic]
    severity: INFO
    message: >-
      A literal that looks like a hardcoded credential. A signal to review; may be a false positive
      (example, placeholder or test value).
    options:
      generic_ellipsis_max_span: 0
    patterns:
      - pattern-regex: (?i)(api[_-]?key|secret|password|passwd|token)\\s*[:=]\\s*["'][A-Za-z0-9/+=_\\-]{8,}["']
`
