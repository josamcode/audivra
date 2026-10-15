import { Link } from '@tanstack/react-router'
import {
  Bot,
  ChevronDown,
  FileText,
  LayoutList,
  Menu,
  Plus,
  ScanSearch,
  Server,
  ShieldCheck,
  ShieldHalf,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { IMAGES } from './images'
import { Logo, Shot, useScrolled } from './primitives'

type Panel = 'platform' | 'workspace'

const CAPABILITIES: { href: string; icon: LucideIcon; title: string; text: string }[] = [
  {
    href: '#scanner',
    icon: ScanSearch,
    title: 'Automated scanning',
    text: 'Crawl, Lighthouse, accessibility checks, links, headers and TLS in a real browser.',
  },
  {
    href: '#ai-auditor',
    icon: Bot,
    title: 'AI Auditor',
    text: 'Investigates the site like an expert and records evidence for every important claim.',
  },
  {
    href: '#ai-reviewer',
    icon: ShieldCheck,
    title: 'AI Reviewer',
    text: 'Challenges weak claims, inflated severity and scanner noise before results are final.',
  },
  {
    href: '#after-the-audit',
    icon: FileText,
    title: 'Reports and history',
    text: 'A client-ready report, exports and a comparison with earlier audits of the site.',
  },
]

const EXPLORE: { href: string; label: string }[] = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#evidence', label: 'Evidence, not guesswork' },
  { href: '#after-the-audit', label: 'After the audit' },
  { href: '#faq', label: 'Questions and answers' },
]

const WORKSPACE: {
  to: '/audits' | '/audits/new' | '/security' | '/system'
  icon: LucideIcon
  title: string
  text: string
}[] = [
  {
    to: '/audits',
    icon: LayoutList,
    title: 'Audits',
    text: 'Every audit you have run, what is running now and what needs follow-up.',
  },
  {
    to: '/audits/new',
    icon: Plus,
    title: 'New audit',
    text: 'Paste a website, choose an audit focus and start a full audit.',
  },
  {
    to: '/security',
    icon: ShieldHalf,
    title: 'Security engagements',
    text: 'Authorized, strictly scoped security assessments.',
  },
  {
    to: '/system',
    icon: Server,
    title: 'System status',
    text: 'The Claude runtime, local audit tools and running processes.',
  },
]

export function SiteHeader() {
  const scrolled = useScrolled()
  const [panel, setPanel] = useState<Panel | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileSection, setMobileSection] = useState<Panel | null>(null)
  const headerRef = useRef<HTMLElement>(null)
  const triggers = useRef<Record<Panel, HTMLButtonElement | null>>({ platform: null, workspace: null })
  const burgerRef = useRef<HTMLButtonElement>(null)

  const anyOpen = panel !== null || mobileOpen

  // Escape and clicks outside the header close whatever is open.
  useEffect(() => {
    if (!anyOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (panel) triggers.current[panel]?.focus()
      else burgerRef.current?.focus()
      setPanel(null)
      setMobileOpen(false)
    }
    const onPointer = (event: PointerEvent) => {
      if (headerRef.current?.contains(event.target as Node)) return
      setPanel(null)
      setMobileOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [anyOpen, panel])

  const closeAll = () => {
    setPanel(null)
    setMobileOpen(false)
  }
  // Following any link inside a menu closes it (anchor links stay on this page).
  const closeOnLink = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) closeAll()
  }
  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next))

  return (
    <header ref={headerRef} className="lp-header" data-solid={scrolled || anyOpen}>
      <div className="lp-wrap lp-header__bar">
        <a href="#top" aria-label="Audivra, back to top" onClick={closeAll}>
          <Logo />
        </a>

        <nav className="lp-nav" aria-label="Main">
          <ul className="lp-nav__list">
            <li className="lp-nav__item">
              <button
                ref={(node) => {
                  triggers.current.platform = node
                }}
                type="button"
                className="lp-nav__trigger"
                aria-expanded={panel === 'platform'}
                aria-controls="lp-mega-platform"
                onClick={() => toggle('platform')}
              >
                Platform
                <ChevronDown aria-hidden />
              </button>
            </li>
            <li className="lp-nav__item">
              <button
                ref={(node) => {
                  triggers.current.workspace = node
                }}
                type="button"
                className="lp-nav__trigger"
                aria-expanded={panel === 'workspace'}
                aria-controls="lp-mega-workspace"
                onClick={() => toggle('workspace')}
              >
                Workspace
                <ChevronDown aria-hidden />
              </button>
            </li>
            <li className="lp-nav__item">
              <a className="lp-nav__link" href="#how-it-works" onClick={closeAll}>
                How it works
              </a>
            </li>
            <li className="lp-nav__item">
              <a className="lp-nav__link" href="#faq" onClick={closeAll}>
                FAQ
              </a>
            </li>
          </ul>
          <div className="lp-nav__actions">
            <Link to="/audits" className="lp-nav__login">
              Open app
            </Link>
            <Link to="/audits/new" className="lp-btn lp-btn--primary lp-btn--compact">
              Audit your website
            </Link>
          </div>
        </nav>

        <button
          ref={burgerRef}
          type="button"
          className="lp-burger"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          aria-controls="lp-mobile-menu"
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? <X aria-hidden /> : <Menu aria-hidden />}
        </button>
      </div>

      <div id="lp-mega-platform" className="lp-mega" hidden={panel !== 'platform'} onClick={closeOnLink}>
        <div className="lp-wrap lp-mega__inner">
          <div>
            <h2 className="lp-mega__title">Audivra capabilities</h2>
            <ul className="lp-mega__grid">
              {CAPABILITIES.map(({ href, icon: Icon, title, text }) => (
                <li key={title}>
                  <a className="lp-mega__cap" href={href}>
                    <Icon aria-hidden />
                    <span>
                      <strong>{title}</strong>
                      <span>{text}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="lp-mega__title">Explore more</h2>
            <ul className="lp-mega__links">
              {EXPLORE.map((item) => (
                <li key={item.href}>
                  <a href={item.href}>{item.label}</a>
                </li>
              ))}
            </ul>
          </div>
          <div className="lp-mega__feature">
            <p>
              Every finding links to <span>the evidence behind it</span>, with the reviewer’s verdict and a
              confidence score.
            </p>
            <Shot image={IMAGES.evidenceFinding} alt="" sizes="400px" />
            <Link to="/audits/new" className="lp-btn lp-btn--primary" style={{ width: 'fit-content' }}>
              Audit your website
            </Link>
          </div>
        </div>
      </div>

      <div id="lp-mega-workspace" className="lp-mega" hidden={panel !== 'workspace'} onClick={closeOnLink}>
        <div className="lp-wrap lp-mega__inner">
          <div>
            <h2 className="lp-mega__title">Your workspace</h2>
            <ul className="lp-mega__grid">
              {WORKSPACE.map(({ to, icon: Icon, title, text }) => (
                <li key={to}>
                  <Link className="lp-mega__cap" to={to}>
                    <Icon aria-hidden />
                    <span>
                      <strong>{title}</strong>
                      <span>{text}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="lp-mega__title">Get started</h2>
            <ul className="lp-mega__links">
              <li>
                <Link to="/audits/new">Start an audit</Link>
              </li>
              <li>
                <Link to="/audits">Open the dashboard</Link>
              </li>
              <li>
                <Link to="/system">Check tool readiness</Link>
              </li>
            </ul>
          </div>
          <div className="lp-mega__feature">
            <p>
              Audivra runs on your machine.{' '}
              <span>The AI works through your own logged-in Claude Code CLI</span>, so there is no API key to
              manage.
            </p>
            <Link
              to="/system"
              className="lp-btn lp-btn--outline"
              style={{ width: 'fit-content', alignSelf: 'end' }}
            >
              Check system status
            </Link>
          </div>
        </div>
      </div>

      <div id="lp-mobile-menu" className="lp-mobile-menu" hidden={!mobileOpen} onClick={closeOnLink}>
        <nav aria-label="Mobile">
          <ul>
            <MobileGroup
              id="platform"
              label="Platform"
              open={mobileSection === 'platform'}
              onToggle={() => setMobileSection((current) => (current === 'platform' ? null : 'platform'))}
            >
              {CAPABILITIES.map(({ href, title, text }) => (
                <li key={title}>
                  <a href={href}>
                    {title}
                    <span>{text}</span>
                  </a>
                </li>
              ))}
            </MobileGroup>
            <MobileGroup
              id="workspace"
              label="Workspace"
              open={mobileSection === 'workspace'}
              onToggle={() => setMobileSection((current) => (current === 'workspace' ? null : 'workspace'))}
            >
              {WORKSPACE.map(({ to, title, text }) => (
                <li key={to}>
                  <Link to={to}>
                    {title}
                    <span>{text}</span>
                  </Link>
                </li>
              ))}
            </MobileGroup>
            <li>
              <a className="lp-mobile-menu__row" href="#how-it-works">
                How it works
              </a>
            </li>
            <li>
              <a className="lp-mobile-menu__row" href="#faq">
                FAQ
              </a>
            </li>
          </ul>
          <div className="lp-mobile-menu__divider" />
          <Link to="/audits" className="lp-mobile-menu__row">
            Open app
          </Link>
          <Link to="/audits/new" className="lp-btn lp-btn--primary">
            Audit your website
          </Link>
        </nav>
      </div>
    </header>
  )
}

function MobileGroup({
  id,
  label,
  open,
  onToggle,
  children,
}: {
  id: Panel
  label: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        className="lp-mobile-menu__row"
        aria-expanded={open}
        aria-controls={`lp-mobile-${id}`}
        onClick={onToggle}
      >
        {label}
        <ChevronDown aria-hidden />
      </button>
      <ul id={`lp-mobile-${id}`} className="lp-mobile-menu__sub" hidden={!open}>
        {children}
      </ul>
    </li>
  )
}
