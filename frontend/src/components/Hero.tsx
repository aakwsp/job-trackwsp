import { useEffect, useRef, useState, type ReactNode } from 'react'

type Props = {
  title: string
  subtitle: string
  // Right-aligned on the subtitle line (the jobs view puts count + sync here).
  aside?: ReactNode
}

// Big lowercase title and one-line subtitle at the top of each view. It
// scrolls with the page; once it's mostly out of sight it fades and lifts,
// so the toolbar sticking under the header reads as taking over from it.
export default function Hero({ title, subtitle, aside }: Props) {
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
    <div ref={ref} className="hero px-6 pt-14 pb-10" data-collapsed={collapsed}>
      <h1 className="text-hero leading-none lowercase">{title}</h1>
      <div className="mt-6 flex items-end justify-between gap-6">
        <p className="max-w-xl text-meta leading-relaxed text-text-muted">{subtitle}</p>
        {aside}
      </div>
    </div>
  )
}
