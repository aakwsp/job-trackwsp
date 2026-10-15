import type { Job } from '../types'
import { GRID_COLS, type ViewMode } from '../lib/view'
import JobCard from './JobCard'
import JobLine from './JobLine'
import { useReveal } from '../lib/reveal'

type Props = {
  city: string
  jobs: Job[]
  view: ViewMode
  collapsed: boolean
  onToggle: (city: string) => void
  onSelect: (job: Job) => void
  onOpen: (job: Job) => void
}

export default function CityGroup({
  city,
  jobs,
  view,
  collapsed,
  onToggle,
  onSelect,
  onOpen,
}: Props) {
  // The band rises in like the cards. The first one on screen rides in just
  // after the hero and toolbar (see PAGE_ENTRY_DELAY_MS in lib/reveal).
  const reveal = useReveal(`band:${city}`)
  return (
    <section>
      {/* The band is the collapse control: a <button> so it gets keyboard
          focus and Enter/Space for free.
          `sticky` pins it under the sticky toolbar while you're inside this
          section; `top-(--toolbar-h)` is Tailwind for `top:
          var(--toolbar-h)`, the toolbar's measured height (set in App). A sticky element can't leave its
          parent, so when the <section> scrolls away the band goes with it
          and the next city's band takes over. `z-10` keeps it above the
          cards (whose stripe is a positioned ::before). */}
      <button
        type="button"
        onClick={() => onToggle(city)}
        aria-expanded={!collapsed}
        {...reveal}
        className="band rise sticky top-(--toolbar-h) z-10 flex w-full cursor-pointer items-center justify-between hover:text-text"
      >
        <span>
          {collapsed ? '+ ' : '- '}// {city.toLowerCase()}
        </span>
        <span className="text-text-dim">{jobs.length}</span>
      </button>

      {/* Kept mounted while collapsed so it can animate closed (height +
          fade, `.reveal` in index.css); `inert` takes the hidden cards out
          of Tab order. */}
      <div className="reveal" data-open={!collapsed} inert={collapsed}>
        <div className="reveal-inner">
          {view === 'line' ? (
            <div>
              {jobs.map((job) => (
                <JobLine key={job.id} job={job} onSelect={onSelect} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <div className={`grid ${GRID_COLS[view]}`}>
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  compact={view === 'compact'}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
