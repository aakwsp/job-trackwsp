import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { StatusColor } from '../types'

// One segment of a custom left stripe: a colour (null = the rule colour,
// used for "closed") and its share, as a count.
export type StripeSegment = { key: string; color: StatusColor | null; n: number }

type Props = {
  title: string
  subtitle: ReactNode
  // Right-aligned on the subtitle line (the jobs view puts count + sync here).
  aside?: ReactNode
  // Replaces the default four equal quarters (the pipeline sizes each
  // stage's colour by how many applications are in it).
  stripe?: StripeSegment[]
}

// Big lowercase title and one-line subtitle at the top of each view. It
// scrolls with the page; once it's mostly out of sight it fades and lifts,
// so the toolbar sticking under the header reads as taking over from it.
export default function Hero({ title, subtitle, aside, stripe }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // IntersectionObserver reports how much of an element is on screen
    // without listening to every scroll event. `threshold: 0.5` = call back
    // whenever visibility crosses 50%. With no `root` it measures against
    // the window, and still accounts for <main> clipping its scrolled
    // content, so it works inside our scrolling <main>.
    const io = new IntersectionObserver(([entry]) => setCollapsed(entry.intersectionRatio < 0.5), {
      threshold: 0.5,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div ref={ref} className="hero px-6 pt-14 pb-10" data-collapsed={collapsed} data-stripe={stripe ? 'custom' : undefined}>
      {/* A flex column where each segment's `flex-grow` is its count, so
          the heights come out proportional with no arithmetic here. */}
      {stripe && (
        <div aria-hidden className="hero-stripe absolute inset-y-0 left-0 flex w-[3px] flex-col">
          {stripe.map((s) => (
            <div
              key={s.key}
              data-color={s.color ?? undefined}
              className={`transition-[flex-grow] duration-(--motion) ${s.color ? 'bg-(--c)' : 'bg-rule-strong'}`}
              style={{ flexGrow: s.n }}
            />
          ))}
        </div>
      )}
      {/* `.enter` (index.css) rises each piece in when the page mounts;
          `--d` staggers them: title, then subtitle, then (in App) the
          toolbar. */}
      <h1 className="enter text-hero leading-none lowercase">{title}</h1>
      <div className="enter mt-6 flex items-end justify-between gap-6" style={{ '--d': '80ms' } as CSSProperties}>
        <p className="max-w-xl text-meta leading-relaxed text-text-muted">{subtitle}</p>
        {aside}
      </div>
    </div>
  )
}
