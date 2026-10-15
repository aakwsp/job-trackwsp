import type { Filters } from '../types'
import { checkedRows, toggleRow } from '../lib/filters'

type Props = {
  filters: Filters
  onChange: (next: Filters) => void
}

// Checked panel rows, visible while the panel is closed. Each chip is a
// button that unchecks that one row.
export default function FilterChips({ filters, onChange }: Props) {
  const rows = checkedRows(filters)
  if (rows.length === 0) return null

  return (
    <span className="flex flex-wrap items-center gap-2">
      {rows.map((row) => (
        <button
          key={`${row.group}:${row.key}`}
          type="button"
          onClick={() => onChange(toggleRow(filters, row))}
          title={`remove "${row.label}"`}
          className="flex cursor-pointer items-center gap-1.5 border border-rule-strong px-1.5 text-meta text-text-muted hover:border-text-muted hover:text-text"
        >
          <span className={row.shape} data-color={row.color} />
          {row.label} ×
        </button>
      ))}
    </span>
  )
}
