import type { Filters } from '../types'
import { VIEW_MODES, type ViewMode } from '../lib/view'
import type { Scale } from '../lib/scale'
import FilterChips from './FilterChips'
import FilterMenu from './FilterMenu'
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
// collapse/expand on the right.
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
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 text-meta">
      <input
        type="search"
        value={filters.query}
        onChange={(e) => onChange({ ...filters, query: e.target.value })}
        placeholder="search company / title"
        aria-label="search company or title"
        className={`${field} w-56`}
      />

      <input
        type="search"
        value={filters.city}
        onChange={(e) => onChange({ ...filters, city: e.target.value })}
        placeholder="city"
        aria-label="city"
        className={`${field} w-36`}
      />

      <FilterMenu filters={filters} onChange={onChange} counts={counts} />
      <FilterChips filters={filters} onChange={onChange} />

      {/* `ml-auto` on the first item of a flex row pushes it and everything
          after it to the right edge. */}
      <span className="ml-auto flex items-center gap-3">
        <span className="mr-2 text-text-dim" title="ui scale · ctrl +/- · ctrl 0 to reset">
          {Math.round(scale * 100)}%
        </span>
        {VIEW_MODES.map(({ mode, glyph, label }) => (
          <button
            key={mode}
            type="button"
            onClick={() => onView(mode)}
            aria-pressed={view === mode}
            title={label}
            className={`cursor-pointer text-body hover:text-text ${view === mode ? 'text-text' : 'text-text-dim'}`}
          >
            {glyph}
          </button>
        ))}
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
