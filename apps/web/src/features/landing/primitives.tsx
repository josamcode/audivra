import { useEffect, useId, useState, type ImgHTMLAttributes, type ReactNode } from 'react'
import { BrandMark } from '@/components/brand-mark'
import type { LandingImage } from './images'

/**
 * A landing screenshot with both widths in srcset, intrinsic size (no layout shift) and lazy loading by
 * default. `sizes` is required so phones pick the smaller file. Pass alt="" where the screenshot is decorative.
 */
export function Shot({
  image,
  sizes,
  alt = image.alt,
  className,
  loading = 'lazy',
  ...rest
}: { image: LandingImage; sizes: string } & Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'srcSet' | 'sizes' | 'width' | 'height'
>) {
  return (
    <img
      src={image.src}
      srcSet={`${image.src} ${image.width}w, ${image.src2x} ${image.width * 2}w`}
      sizes={sizes}
      width={image.width}
      height={image.height}
      alt={alt}
      loading={loading}
      decoding="async"
      className={className}
      {...rest}
    />
  )
}

export function Logo() {
  return (
    <span className="lp-logo">
      <BrandMark fillClassName="lp-logo__fill" strokeClassName="lp-logo__stroke" />
      <span className="lp-logo__word">Audivra</span>
    </span>
  )
}

/** A document-unique id for SVG paint servers; useId output is awkward inside url(#…), so it is reduced. */
export function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}

/** Four-point spark used in eyebrows, filled with the brand gradient. */
export function Spark() {
  const gradient = useSvgId('lp-spark')
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b24c7" />
          <stop offset="1" stopColor="#206fed" />
        </linearGradient>
      </defs>
      <path
        d="M8 0c.5 4.1 3.9 7.5 8 8-4.1.5-7.5 3.9-8 8-.5-4.1-3.9-7.5-8-8 4.1-.5 7.5-3.9 8-8Z"
        fill={`url(#${gradient})`}
      />
    </svg>
  )
}

export function Eyebrow({ children, spark = false }: { children: ReactNode; spark?: boolean }) {
  return (
    <p className="lp-eyebrow">
      {spark ? <Spark /> : null}
      <span className="lp-eyebrow__text">{children}</span>
    </p>
  )
}

/** True once the page has scrolled past `offset` pixels (the reference header turns solid at 2px). */
export function useScrolled(offset = 2): boolean {
  const [scrolled, setScrolled] = useState(() => window.scrollY > offset)
  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      setScrolled(window.scrollY > offset)
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.cancelAnimationFrame(frame)
    }
  }, [offset])
  return scrolled
}
