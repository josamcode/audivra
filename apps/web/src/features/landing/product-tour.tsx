import { useEffect, useRef, useState } from 'react'
import { useMediaQuery } from '@/lib/hooks'
import { IMAGES, type LandingImage } from './images'
import { Shot } from './primitives'

/** The reference's autoplaying hero video, rebuilt as a paced walk through real screens of one audit. */
const SCENES: { question: string; image: LandingImage }[] = [
  { question: 'What does my website need?', image: IMAGES.tourOverview },
  { question: 'Which issues matter most?', image: IMAGES.tourFindings },
  { question: 'Can I trust each finding?', image: IMAGES.tourEvidence },
  { question: 'How do I share the results?', image: IMAGES.tourReport },
]
const SCENE_MS = 4500

export function ProductTour() {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [active, setActive] = useState(0)
  // null = follow the motion preference; true/false once the visitor uses the toggle.
  const [userPaused, setUserPaused] = useState<boolean | null>(null)
  const [visible, setVisible] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)
  const paused = userPaused ?? reducedMotion

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), {
      threshold: 0.35,
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (paused || !visible) return
    const timer = window.setInterval(() => setActive((index) => (index + 1) % SCENES.length), SCENE_MS)
    return () => window.clearInterval(timer)
  }, [paused, visible, active])

  const scene = SCENES[active] ?? SCENES[0]!

  return (
    <section className="lp-tour" aria-label="Product tour">
      <div ref={frameRef} className="lp-tour__frame">
        <ol className="lp-tour__questions">
          {SCENES.map((item, index) => (
            <li key={item.question}>
              <button
                type="button"
                className="lp-tour__q"
                aria-current={index === active ? 'true' : undefined}
                aria-controls="lp-tour-window"
                onClick={() => setActive(index)}
              >
                {item.question}
              </button>
            </li>
          ))}
        </ol>
        <p className="lp-tour__caption" aria-hidden>
          {scene.question}
        </p>
        <div id="lp-tour-window" className="lp-tour__window">
          {SCENES.map((item, index) => (
            <Shot
              key={item.question}
              image={item.image}
              className="lp-tour__scene"
              data-active={index === active}
              aria-hidden={index === active ? undefined : true}
              sizes="(min-width: 1025px) 760px, (min-width: 768px) calc(100vw - 400px), calc(100vw - 40px)"
              loading={index === 0 ? 'eager' : 'lazy'}
              fetchPriority={index === 0 ? 'high' : undefined}
            />
          ))}
        </div>
        <div className="lp-tour__dots">
          {SCENES.map((item, index) => (
            <button
              key={item.question}
              type="button"
              className="lp-tour__dot"
              aria-label={item.question}
              aria-current={index === active ? 'true' : undefined}
              onClick={() => setActive(index)}
            />
          ))}
        </div>
        <button
          type="button"
          className="lp-tour__toggle"
          aria-label={paused ? 'Play product tour' : 'Pause product tour'}
          onClick={() => setUserPaused(!paused)}
        >
          {paused ? (
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
            </svg>
          )}
        </button>
      </div>
    </section>
  )
}
