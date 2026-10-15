import { useEffect, useId, useRef, useState } from 'react'
import type { Filters } from '../types'
import { FLAG_ROWS, STATUS_ROWS, checkedRows, isChecked, resetPanel, rowId, toggleRow, type FilterRow } from '../lib/filters'
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

  const count = checkedRows(filters).length

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

      {open && (
        // `top-full` = directly under the trigger; `mt-2` leaves a small gap.
        // `z-20` puts it above the sticky city bands (`z-10`).
        <div
          id={panelId}
          className="absolute top-full left-0 z-20 mt-2 w-72 border border-rule bg-bg-card"
        >
          <Group title="status" rows={STATUS_ROWS} filters={filters} counts={counts} onChange={onChange} />
          <Group title="flags" rows={FLAG_ROWS} filters={filters} counts={counts} onChange={onChange} />

          <div className="flex justify-end border-t border-rule px-6 py-2">
            <button type="button" onClick={() => onChange(resetPanel(filters))} className={`${textButton} text-text-muted`}>
              [ clear ]
            </button>
          </div>
        </div>
      )}
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

// One `// status` or `// flags` section. Each row is drawn with its marker
// shape and colour, so the panel is also the legend.
function Group({ title, rows, filters, counts, onChange }: GroupProps) {
  return (
    <>
      <div className="band">// {title}</div>
      <div className="flex flex-col gap-1.5 px-6 py-3">
        {rows.map((row) => {
          const checked = isChecked(filters, row)
          return (
            <button
              key={rowId(row)}
              type="button"
              onClick={() => onChange(toggleRow(filters, row))}
              aria-pressed={checked}
              className={`${textButton} flex items-center gap-2.5 ${checked ? 'text-text' : 'text-text-muted'}`}
            >
              {checked ? '[x]' : '[ ]'}
              {/* fixed-width box so labels line up whether the shape is the
                  wider rotated diamond or the square */}
              <span className="flex w-3.5 justify-center">
                <span className={row.shape} data-color={row.color} />
              </span>
              {row.label}
              {/* `ml-auto` pushes the count to the right edge of the row */}
              <span className="ml-auto text-text-dim">{counts.get(rowId(row)) ?? 0}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}
