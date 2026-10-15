import { CreateAuditInput } from '@audivra/contracts'
import { useNavigate } from '@tanstack/react-router'
import {
  Accessibility,
  Gauge,
  ListChecks,
  Lock,
  Monitor,
  Network,
  Route,
  ShieldHalf,
  type LucideIcon,
} from 'lucide-react'
import { useId, useRef, useState, type FormEvent } from 'react'
import { Eyebrow } from './primitives'

/** The open-source tools behind the deterministic baseline (ZAP and testssl.sh are optional Docker scanners). */
const TOOLS: { name: string; icon: LucideIcon }[] = [
  { name: 'Playwright', icon: Monitor },
  { name: 'Lighthouse', icon: Gauge },
  { name: 'axe-core', icon: Accessibility },
  { name: 'Pa11y', icon: ListChecks },
  { name: 'OWASP ZAP', icon: ShieldHalf },
  { name: 'testssl.sh', icon: Lock },
  { name: 'httpx', icon: Network },
  { name: 'Katana', icon: Route },
]

/**
 * Validates the URL with the same rule the API uses, then hands it to the existing New audit page, where
 * the audit focus is chosen and the audit is actually started.
 */
export function UrlForm({ buttonLabel = 'Audit your website' }: { buttonLabel?: string }) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const result = CreateAuditInput.shape.url.safeParse(value)
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? 'Enter a valid http(s) website URL')
      inputRef.current?.focus()
      return
    }
    void navigate({ to: '/audits/new', search: { url: result.data } })
  }

  return (
    <form className="lp-urlform" noValidate onSubmit={onSubmit} aria-label="Audit a website">
      <div className="lp-urlform__field">
        <label htmlFor={`${id}-url`} className="sr-only">
          Website URL
        </label>
        <input
          ref={inputRef}
          id={`${id}-url`}
          className="lp-urlform__input"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="Type your website URL"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            if (error) setError(null)
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <button type="submit" className="lp-btn lp-btn--primary lp-urlform__btn">
          {buttonLabel}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="lp-urlform__error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}

export function Hero() {
  return (
    <div className="lp-top">
      <section className="lp-wrap lp-hero" aria-labelledby="lp-hero-title">
        <Eyebrow spark>AI-powered website intelligence</Eyebrow>
        <h1 id="lp-hero-title" className="lp-h1">
          <span className="lp-h1__line">Know what your website needs.</span>{' '}
          <span className="lp-h1__line">Know what to fix next.</span>
        </h1>
        <p className="lp-hero__copy">
          Audivra combines automated scanning, browser-based AI auditing and an independent AI review to
          uncover website issues with evidence you can trust.
        </p>
        <UrlForm />
        <p className="lp-hero__note">
          You choose the audit focus before anything runs. <a href="#how-it-works">See how it works</a>
        </p>
      </section>

      <section className="lp-strip" aria-labelledby="lp-strip-title">
        <h2 id="lp-strip-title" className="lp-strip__title">
          Baseline checks built on proven open-source tools
        </h2>
        <div className="lp-strip__viewport">
          <ul className="lp-strip__track">
            {[0, 1, 2, 3].flatMap((copy) =>
              TOOLS.map(({ name, icon: Icon }) => (
                <li
                  key={`${copy}-${name}`}
                  className="lp-strip__item"
                  aria-hidden={copy > 0 ? true : undefined}
                >
                  <Icon aria-hidden />
                  {name}
                </li>
              )),
            )}
          </ul>
        </div>
      </section>
    </div>
  )
}
