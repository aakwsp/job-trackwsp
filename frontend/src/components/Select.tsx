import type { ReactNode } from 'react'

// A <select> that looks like the rest of the app on every platform:
// `appearance: none` stops WebKitGTK drawing a native GTK control (light
// background, which left our pale text unreadable), so the box is just
// tokens + a hairline, with a mono ▾ drawn on top. The options' colours are
// set too; the popup list itself follows `color-scheme: dark` (index.css).
type Props = {
  value: string | number
  onChange: (value: string) => void
  label: string
  className?: string // sizing (height, width / flex) from the caller
  children: ReactNode
}

export default function Select({ value, onChange, label, className = '', children }: Props) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-full w-full cursor-pointer appearance-none border border-rule-strong bg-bg pr-7 pl-2.5 text-meta text-text outline-none hover:border-text-muted focus-visible:border-text [&>option]:bg-bg [&>option]:text-text"
      >
        {children}
      </select>
      <span aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-meta text-text-muted">
        ▾
      </span>
    </span>
  )
}
