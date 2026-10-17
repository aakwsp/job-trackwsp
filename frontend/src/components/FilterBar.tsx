import { useRef } from 'react'
import type { Filters, JobSort } from '../types'
import { activeRows } from '../lib/filters'
import { JOB_SORTS } from '../lib/jobs'
import { useSqueeze } from '../lib/useSqueeze'
import { VIEW_MODES, type ViewMode } from '../lib/view'
import FilterChips from './FilterChips'
import FilterMenu from './FilterMenu'
import SortControl from './SortControl'
import { field, textButton } from './styles'

type Props = {
  filters: Filters
  onChange: (next: Filters) => void
  // Per-row counts for the filter panel.
  counts: Map<string, number>
  view: ViewMode
  onView: (v: ViewMode) => void
  // Sorted in Rust (JT-39); null until the remembered one has loaded.
  sort: JobSort | null
  onSort: (s: JobSort) => void
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
  sort,
  onSort,
  onCollapseAll,
  onExpandAll,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const chips = activeRows(filters).map(({ row, mode }) => `${row.group}:${row.key}:${mode}`)
  const squeezed = useSqueeze(ref, `${chips.join(',')}|${sort}|${view}`)
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
        {/* Where INBOX has its sort: first on the right. */}
        {sort && <SortControl<JobSort> options={JOB_SORTS} value={sort} onChange={onSort} />}
        {/* [ view · line ]: the same control as sort. */}
        <SortControl<ViewMode>
          label="view"
          options={VIEW_MODES.map(({ mode, word, label }) => ({ key: mode, label: word, title: label }))}
          value={view}
          onChange={onView}
        />
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
