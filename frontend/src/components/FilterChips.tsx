import type { Filters } from '../types'
import { activeRows, setRow } from '../lib/filters'

type Props = {
  filters: Filters
  onChange: (next: Filters) => void
  /** Squeezed toolbar: only the shape and ×; the label is in the title. */
  compact?: boolean
}

// Rows that aren't off, visible while the panel is closed: "+ borderline"
// for an include, "− past due" for an exclude. Each chip is a button that
// turns that one row off. `compact` drops the text when the toolbar is
// too narrow for it (see `useSqueeze`).
export default function FilterChips({ filters, onChange, compact = false }: Props) {
  const rows = activeRows(filters)
  if (rows.length === 0) return null

  return (
    <span className="flex shrink-0 items-center gap-2">
      {rows.map(({ row, mode }) => {
        const sign = mode === 'include' ? '+' : '−'
        return (
          <button
            key={`${row.group}:${row.key}`}
            type="button"
            onClick={() => onChange(setRow(filters, row, null))}
            title={`clear "${sign} ${row.label}"`}
            aria-label={`clear ${sign} ${row.label}`}
            className={`flex cursor-pointer items-center gap-1.5 border whitespace-nowrap border-rule-strong px-1.5 text-meta hover:border-text-muted hover:text-text ${
              mode === 'include' ? 'text-text-muted' : 'text-text-dim'
            }`}
          >
            <span className={row.shape} data-color={row.color} />
            {compact ? '×' : `${sign} ${row.label} ×`}
          </button>
        )
      })}
    </span>
  )
}
