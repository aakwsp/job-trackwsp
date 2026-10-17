import { useRef } from 'react'
import type { Filters } from '../types'
import { activeRows } from '../lib/filters'
import { useSqueeze } from '../lib/useSqueeze'
import { VIEW_MODES, type ViewMode } from '../lib/view'
import type { Scale } from '../lib/scale'
import FilterChips from './FilterChips'
import FilterMenu from './FilterMenu'
import OptionButton from './OptionButton'
import { field, textButton } from './styles'

type Props = {
  filters: Filters
  onChange: (next: Filters) => void
  // Per-row counts for the filter panel.
  counts: Map<string, number>
  view: ViewMode
  onView: (v: ViewMode) => void
  scale: Scale
  onCollapseAll: () => void
  onExpandAll: () => void
}

// The toolbar: search, city, [ filters ] + chips, then view modes and
// collapse/expand on the right. Always one line: when it doesn't fit, the
// chips go shape-only and the search boxes shrink (`useSqueeze`).
export default function FilterBar({
  filters,
  onChange,
  counts,
  view,
  onView,
  scale,
  onCollapseAll,
  onExpandAll,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const chips = activeRows(filters).map(({ row, mode }) => `${row.group}:${row.key}:${mode}`)
  const squeezed = useSqueeze(ref, `${chips.join(',')}|${scale}`)
  // Unsqueezed nothing may shrink, so overflow shows up to be measured.
  const box = squeezed ? 'min-w-0 shrink' : 'shrink-0'
  return (
    <div ref={ref} className="flex flex-nowrap items-center gap-x-4 px-6 py-3 text-meta">
      <input
        type="search"
        value={filters.query}
        onChange={(e) => onChange({ ...filters, query: e.target.value })}
        placeholder="search company / title"
        aria-label="search company or title"
        className={`${field} w-56 ${box}`}
      />

      <input
        type="search"
        value={filters.city}
        onChange={(e) => onChange({ ...filters, city: e.target.value })}
        placeholder="hub / city"
        aria-label="hub or city"
        className={`${field} w-36 ${box}`}
      />

      <div className="shrink-0">
        <FilterMenu filters={filters} onChange={onChange} counts={counts} />
      </div>
      <FilterChips filters={filters} onChange={onChange} compact={squeezed} />

      {/* `ml-auto` on the first item of a flex row pushes it and everything
          after it to the right edge. */}
      <span className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap">
        <span className="mr-2 text-text-dim" title="ui scale · ctrl +/- · ctrl 0 to reset">
          {Math.round(scale * 100)}%
        </span>
        {/* Same words-with-underline control as INBOX's sort. */}
        <span className="flex items-center gap-1">
          <span className="pr-0.5 text-text-dim">view</span>
          {VIEW_MODES.map(({ mode, word, label }) => (
            <OptionButton key={mode} on={view === mode} onClick={() => onView(mode)} title={label}>
              {word}
            </OptionButton>
          ))}
        </span>
        <button type="button" onClick={onCollapseAll} className={`${textButton} ml-2 text-text-muted`} title="collapse all">
          [ - ]
        </button>
        <button type="button" onClick={onExpandAll} className={`${textButton} text-text-muted`} title="expand all">
          [ + ]
        </button>
      </span>
    </div>
  )
}
