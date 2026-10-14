import type { Filters } from '../types'

type Props = {
  filters: Filters
  cities: string[]
  sources: string[]
  onChange: (next: Filters) => void
  onCollapseAll: () => void
  onExpandAll: () => void
}

const field =
  'border border-rule-strong bg-bg px-2 py-1 text-text outline-none placeholder:text-text-dim focus:border-text-muted'

type ToggleKey = 'unappliedOnly' | 'closingOnly' | 'hideBorderline'

const TOGGLES: { key: ToggleKey; label: string }[] = [
  { key: 'unappliedOnly', label: 'unapplied only' },
  { key: 'closingOnly', label: 'closing ≤ 7d' },
  { key: 'hideBorderline', label: 'hide borderline' },
]

export default function FilterBar({ filters, cities, sources, onChange, onCollapseAll, onExpandAll }: Props) {
  // Every control replaces one key and keeps the rest — `{ ...filters, x }`
  // makes a new object, which is what tells React state changed.
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onChange({ ...filters, [key]: value })

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 text-[11px]">
      <input
        type="search"
        value={filters.query}
        onChange={(e) => set('query', e.target.value)}
        placeholder="search company / title"
        className={`${field} w-56`}
      />

      <select value={filters.city} onChange={(e) => set('city', e.target.value)} className={field}>
        <option value="">any city</option>
        {cities.map((c) => (
          <option key={c} value={c}>
            {c.toLowerCase()}
          </option>
        ))}
      </select>

      <select value={filters.source} onChange={(e) => set('source', e.target.value)} className={field}>
        <option value="">any source</option>
        {sources.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {TOGGLES.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => set(key, !filters[key])}
          aria-pressed={filters[key]}
          className={`cursor-pointer whitespace-nowrap hover:text-text ${filters[key] ? 'text-text' : 'text-text-muted'}`}
        >
          {filters[key] ? '[x]' : '[ ]'} {label}
        </button>
      ))}

      {/* `ml-auto` on the first item of a flex row pushes it and everything
          after it to the right edge. */}
      <span className="ml-auto flex gap-3 text-text-muted">
        <button type="button" onClick={onCollapseAll} className="cursor-pointer hover:text-text" title="collapse all">
          [ - ]
        </button>
        <button type="button" onClick={onExpandAll} className="cursor-pointer hover:text-text" title="expand all">
          [ + ]
        </button>
      </span>
    </div>
  )
}
