import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { field, textButton } from '../styles'
import type { MailSort } from '../../lib/inbox'
import {
  READ_ROWS,
  STATE_ROWS,
  activeInboxRows,
  setInboxRow,
  type InboxFilterKey,
  type InboxFilterRow,
  type InboxFilters,
} from '../../lib/inboxFilters'

// INBOX's toolbar band (JT-18), laid out like the JOBS FilterBar and built
// from the same pieces (`field`, `textButton`, `.band`, `.reveal`,
// marker / flag shapes), without touching the JOBS components: left, the
// boxed search and [ filters ] + chips; right, sort (which is also the
// view), the list fold and fold / unfold all sections.

type Props = {
  searchRef: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (q: string) => void
  filters: InboxFilters
  onFilters: (f: InboxFilters) => void
  counts: Map<InboxFilterKey, number>
  sort: MailSort
  onSort: (s: MailSort) => void
  narrow: boolean
  onNarrow: () => void
  onCollapseAll: () => void
  onExpandAll: () => void
}

// `searchRef` is taken out of `p` so the linter doesn't treat every
// prop as a ref.
export default function InboxBar({ searchRef, ...p }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 text-meta">
      <input
        ref={searchRef}
        type="search"
        value={p.query}
        onChange={(e) => p.onQuery(e.target.value)}
        onKeyDown={(e) => {
          // esc clears and leaves the field (so the list keys work again).
          // Handled here, so nothing else reacts to it.
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            p.onQuery('')
            e.currentTarget.blur()
          }
        }}
        placeholder="search company / subject / body"
        aria-label="search company, role, subject, sender or body (/)"
        className={`${field} w-80`}
      />
      <InboxFilterMenu filters={p.filters} onChange={p.onFilters} counts={p.counts} />
      <InboxFilterChips filters={p.filters} onChange={p.onFilters} />

      <span className="ml-auto flex items-center gap-3">
        {/* Sort is the view switch (newest = by email, company = by
            job); keeps INBOX's underline for the active one. */}
        <span className="flex items-center gap-1">
          <span className="pr-0.5 text-text-dim">sort</span>
          {(['newest', 'company'] as MailSort[]).map((s) => (
            <SortButton key={s} on={p.sort === s} onClick={() => p.onSort(s)}>
              {s}
            </SortButton>
          ))}
        </span>
        <button
          type="button"
          onClick={p.onNarrow}
          aria-pressed={p.narrow}
          title={p.narrow ? 'expand the list ([)' : 'collapse the list ([)'}
          className={`${textButton} ml-2 text-text-muted`}
        >
          {p.narrow ? '[ » ]' : '[ « ]'}
        </button>
        <button type="button" onClick={p.onCollapseAll} className={`${textButton} text-text-muted`} title="collapse all">
          [ - ]
        </button>
        <button type="button" onClick={p.onExpandAll} className={`${textButton} text-text-muted`} title="expand all">
          [ + ]
        </button>
      </span>
    </div>
  )
}

// The sort words: the active one in text colour with a hairline under it.
function SortButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`h-7 cursor-pointer appearance-none border-b bg-transparent px-1.5 hover:text-text ${
        on ? 'border-text text-text' : 'border-transparent text-text-dim'
      }`}
    >
      {children}
    </button>
  )
}

// The box in front of each row, by state (as in JOBS' FilterMenu).
const GLYPH = { off: '[ ]', include: '[+]', exclude: '[−]' } as const

// [ filters ] and its drop-down: the JOBS FilterMenu's markup and
// behaviour (outside click / esc / tabbing away close it; click cycles
// off → include → exclude; shift+click or right-click excludes), over
// INBOX's rows.
function InboxFilterMenu({
  filters,
  onChange,
  counts,
}: {
  filters: InboxFilters
  onChange: (f: InboxFilters) => void
  counts: Map<InboxFilterKey, number>
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const count = activeInboxRows(filters).length

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null
        if (open && to && !e.currentTarget.contains(to)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className={`${textButton} ${count > 0 || open ? 'text-text' : 'text-text-muted'}`}
      >
        [ filters{count > 0 && ` · ${count}`} ]
      </button>
      <div id={panelId} className="reveal absolute top-full left-0 z-20 mt-2 w-72" data-open={open} inert={!open}>
        <div className="reveal-inner">
          <div className="border border-rule bg-bg-card">
            <Group title="state" rows={STATE_ROWS} filters={filters} counts={counts} onChange={onChange} />
            <Group title="read" rows={READ_ROWS} filters={filters} counts={counts} onChange={onChange} />
            <div className="flex justify-end border-t border-rule px-6 py-2">
              <button type="button" onClick={() => onChange({})} className={`${textButton} text-text-muted`}>
                [ clear ]
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Group({
  title,
  rows,
  filters,
  counts,
  onChange,
}: {
  title: string
  rows: InboxFilterRow[]
  filters: InboxFilters
  counts: Map<InboxFilterKey, number>
  onChange: (f: InboxFilters) => void
}) {
  return (
    <>
      <div className="band">// {title}</div>
      <div className="flex flex-col gap-1.5 px-6 py-3">
        {rows.map((row) => {
          const mode = filters[row.key]
          return (
            <button
              key={row.key}
              type="button"
              onClick={(e) => onChange(setInboxRow(filters, row.key, e.shiftKey ? 'exclude' : 'cycle'))}
              onContextMenu={(e) => {
                e.preventDefault()
                onChange(setInboxRow(filters, row.key, 'exclude'))
              }}
              aria-label={`${row.label}: ${mode ?? 'off'}`}
              title="click to cycle · shift+click or right-click to exclude"
              className={`${textButton} flex items-center gap-2.5 ${
                mode === 'include' ? 'text-text' : mode === 'exclude' ? 'text-text-dim' : 'text-text-muted'
              }`}
            >
              {GLYPH[mode ?? 'off']}
              <span className="flex w-3.5 justify-center">
                <span className={row.shape} data-color={row.color} />
              </span>
              <span className={mode === 'exclude' ? 'line-through' : ''}>{row.label}</span>
              <span className="ml-auto text-text-dim">{counts.get(row.key) ?? 0}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

// Active rows as chips while the panel is closed, like JOBS' FilterChips:
// each turns its row off.
function InboxFilterChips({ filters, onChange }: { filters: InboxFilters; onChange: (f: InboxFilters) => void }) {
  const rows = activeInboxRows(filters)
  if (rows.length === 0) return null
  return (
    <span className="flex flex-wrap items-center gap-2">
      {rows.map(({ row, mode }) => {
        const sign = mode === 'include' ? '+' : '−'
        return (
          <button
            key={row.key}
            type="button"
            onClick={() => onChange(setInboxRow(filters, row.key, null))}
            title={`clear "${sign} ${row.label}"`}
            className={`flex cursor-pointer items-center gap-1.5 border border-rule-strong px-1.5 text-meta hover:border-text-muted hover:text-text ${
              mode === 'include' ? 'text-text-muted' : 'text-text-dim'
            }`}
          >
            <span className={row.shape} data-color={row.color} />
            {sign} {row.label} ×
          </button>
        )
      })}
    </span>
  )
}
