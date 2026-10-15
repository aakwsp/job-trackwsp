import type { ReactNode } from 'react'
import type { StatusColor } from '../../types'
import { agoText } from '../../lib/jobs'

// Small pieces shared by the record's sections. Moved here from JT-32's
// JobDetail, which this record replaces.

// Button looks. Full literals so Tailwind's source scan sees every class.
// The two bordered ones are 44px tall, a comfortable click target.
export const ghostButton = 'inline-flex h-8 cursor-pointer items-center px-1 text-meta text-text-muted hover:text-text'
export const outlineButton =
  'inline-flex h-11 cursor-pointer items-center border border-rule-strong px-4 text-meta text-text hover:border-text-muted hover:bg-bg disabled:cursor-default disabled:text-text-dim disabled:hover:border-rule-strong disabled:hover:bg-transparent'
// [ applied ✓ ]: the outline button in green. Its own string rather than
// `outlineButton` + `text-green`, because two text colours on one element
// don't resolve by order in `className` (see styles.ts).
export const appliedButton =
  'inline-flex h-11 cursor-pointer items-center border border-rule-strong px-4 text-meta text-green hover:border-text-muted hover:bg-bg'
// The one filled button. `hover:opacity-90` lightens it a touch against the
// dark panel without inventing a new colour.
export const primaryButton =
  'inline-flex h-11 cursor-pointer items-center border border-text bg-text px-[1.125rem] text-meta font-bold text-bg hover:opacity-90'

// Side padding for a section's contents. The drawer and the two columns of
// the expanded page each indent differently, so sections take it as a prop.
export type Pad = string
export const DRAWER_PAD: Pad = 'pr-8 pl-[2.1875rem]'

// A button label with its keyboard shortcut as a dim suffix:
// "[ mark applied · a ]". The same keys are listed in the hint line at the
// bottom of the record.
export function Keyed({ label, k }: { label: string; k: string }) {
  return (
    <>
      [ {label} <span className="text-text-dim">· {k}</span> ]
    </>
  )
}

// A `// section` header band: full width, 36px, hairlines above and below.
// `noTop` drops the top hairline where something directly above already
// draws one.
export function Band({
  children,
  pad,
  noTop = false,
  aside,
}: {
  children: ReactNode
  pad: Pad
  noTop?: boolean
  aside?: ReactNode
}) {
  return (
    <div
      className={`flex h-9 items-center border-b border-rule bg-bg text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase ${
        noTop ? '' : 'border-t'
      } ${pad}`}
    >
      {children}
      {aside && (
        <span className="ml-auto text-[0.625rem] tracking-[0.02em] text-text-dim normal-case">{aside}</span>
      )}
    </div>
  )
}

// A label/value grid. Every row but the first gets a hairline on top, on
// both cells, so the line runs the full width.
export function Details({ children }: { children: ReactNode }) {
  return <dl className="m-0 grid grid-cols-[8.5rem_minmax(0,1fr)] text-meta leading-normal">{children}</dl>
}

export function Row({ label, first = false, children }: { label: string; first?: boolean; children: ReactNode }) {
  const rule = first ? '' : 'border-t border-rule'
  return (
    <>
      <dt className={`py-2 text-text-muted ${rule}`}>{label}</dt>
      <dd className={`m-0 py-2 ${rule}`}>{children}</dd>
    </>
  )
}

export function Dated({ ymd, ago }: { ymd: string | null; ago?: string }) {
  if (!ymd) return <span className="text-text-muted">—</span>
  return (
    <>
      {ymd} <span className="text-text-muted">· {ago ?? agoText(ymd)}</span>
    </>
  )
}

// A bordered status tag (`.label` in index.css). 'muted' is for a closed
// application, which has no status colour.
export type TagColor = StatusColor | 'muted'
export type TagSpec = { key: string; color: TagColor; text: string }

export function Tags({ tags }: { tags: TagSpec[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <span key={t.key} className="label text-micro" data-color={t.color}>
          {t.text}
        </span>
      ))}
    </span>
  )
}

// The big dim "[ not applied yet ]"-style empty state inside a section.
export function Empty({ title, children, pad }: { title: string; children: ReactNode; pad: Pad }) {
  return (
    <div className={`pt-10 pb-2 ${pad}`}>
      <p className="font-serif text-[1.625rem] leading-[1.1] text-text-dim">{title}</p>
      <div className="mt-2.5 text-[0.65625rem] leading-[1.7] text-text-dim">{children}</div>
    </div>
  )
}

// Two corner arrows: pointing out to expand, in to collapse.
export function ExpandIcon({ collapse }: { collapse: boolean }) {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="square"
      className="mx-1.5"
    >
      <path d={collapse ? 'M11 5H7V1M7 5l4-4M1 7h4v4M5 7l-4 4' : 'M7 1h4v4M11 1L7 5M5 11H1V7M1 11l4-4'} />
    </svg>
  )
}
