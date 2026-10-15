import { useEffect, useId, useRef, useState } from 'react'
import type { Filters } from '../types'
import { FLAG_ROWS, STATUS_ROWS, activeRows, cycleRow, resetPanel, rowId, rowMode, setRow, type FilterRow } from '../lib/filters'
import { textButton } from './styles'

type Props = {
  filters: Filters
  onChange: (next: Filters) => void
  // Per-row counts from `rowCounts`, keyed by `rowId`.
  counts: Map<string, number>
}

// The [ filters ] trigger and its drop-down panel.
export default function FilterMenu({ filters, onChange, counts }: Props) {
  const [open, setOpen] = useState(false)
  // The wrapper around trigger + panel, so "outside" can be tested with
  // `contains`. A ref is a box React keeps the real DOM node in.
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // A unique id to link the trigger to the panel for screen readers.
  const panelId = useId()

  // Every row that isn't off, include or exclude.
  const count = activeRows(filters).length

  // Listen on the whole document only while open, and remove the listeners
  // when it closes (the returned cleanup function), so a closed menu costs
  // nothing.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        // Hand focus back to the trigger, so keyboard users aren't left
        // focused on something that just disappeared.
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
    // `relative` makes this the anchor for the `absolute` panel below.
    // onBlur bubbles in React (it's really `focusout`), so this fires when
    // focus leaves any element inside; `relatedTarget` is where focus went.
    // Tabbing to something outside closes the panel. A null `relatedTarget`
    // (e.g. WebKit not focusing a clicked button) is left to the
    // outside-click listener instead, so clicking a toggle can't close it.
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

      {/* Always mounted so it can animate both ways: `.reveal` (index.css)
          grows it from zero height and fades it in when `data-open` flips.
          `inert` while closed takes it out of Tab order and clicks, since
          it's still in the page.
          `top-full` = directly under the trigger; `mt-2` leaves a small gap.
          `z-20` puts it above the sticky city bands (`z-10`). */}
      <div id={panelId} className="reveal absolute top-full left-0 z-20 mt-2 w-72" data-open={open} inert={!open}>
        <div className="reveal-inner">
          <div className="border border-rule bg-bg-card">
            <Group title="status" rows={STATUS_ROWS} filters={filters} counts={counts} onChange={onChange} />
            <Group title="flags" rows={FLAG_ROWS} filters={filters} counts={counts} onChange={onChange} />

            <div className="flex justify-end border-t border-rule px-6 py-2">
              <button
                type="button"
                onClick={() => onChange(resetPanel(filters))}
                className={`${textButton} text-text-muted`}
              >
                [ clear ]
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

type GroupProps = {
  title: string
  rows: FilterRow[]
  filters: Filters
  counts: Map<string, number>
  onChange: (next: Filters) => void
}

// The box in front of each row, by state.
const GLYPH = { off: '[ ]', include: '[+]', exclude: '[−]' } as const

// One `// status` or `// flags` section. Each row is drawn with its marker
// shape and colour, so the panel is also the legend.
//
// A row is a three-state toggle: click (or Space, which clicks a focused
// button) cycles off → include → exclude → off. Shift+click and right-click
// jump straight to exclude.
function Group({ title, rows, filters, counts, onChange }: GroupProps) {
  return (
    <>
      <div className="band">// {title}</div>
      <div className="flex flex-col gap-1.5 px-6 py-3">
        {rows.map((row) => {
          const mode = rowMode(filters, row)
          return (
            <button
              key={rowId(row)}
              type="button"
              onClick={(e) => onChange(e.shiftKey ? setRow(filters, row, 'exclude') : cycleRow(filters, row))}
              // `contextmenu` is the right-click event; preventDefault stops
              // the webview's own menu from opening on top.
              onContextMenu={(e) => {
                e.preventDefault()
                onChange(setRow(filters, row, 'exclude'))
              }}
              // No `aria-pressed` (it only has on/off), so the state is
              // spelled out in the accessible name instead.
              aria-label={`${row.label}: ${mode ?? 'off'}`}
              title="click to cycle · shift+click or right-click to exclude"
              className={`${textButton} flex items-center gap-2.5 ${
                mode === 'include' ? 'text-text' : mode === 'exclude' ? 'text-text-dim' : 'text-text-muted'
              }`}
            >
              {GLYPH[mode ?? 'off']}
              {/* fixed-width box so labels line up whether the shape is the
                  wider rotated diamond or the square */}
              <span className="flex w-3.5 justify-center">
                <span className={row.shape} data-color={row.color} />
              </span>
              {/* Struck through when excluded: reads as "not this". */}
              <span className={mode === 'exclude' ? 'line-through' : ''}>{row.label}</span>
              {/* `ml-auto` pushes the count to the right edge of the row */}
              <span className="ml-auto text-text-dim">{counts.get(rowId(row)) ?? 0}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}
