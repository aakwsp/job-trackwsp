import type { Job } from '../types'
import { GRID_COLS, type ViewMode } from '../lib/view'
import JobCard from './JobCard'
import JobLine from './JobLine'

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
  return (
    <section>
      {/* The band is the collapse control: a <button> so it gets keyboard
          focus and Enter/Space for free.
          `sticky top-0` pins it to the top of the scrolling <main> while
          you're inside this section. A sticky element can't leave its
          parent, so when the <section> scrolls away the band goes with it
          and the next city's band takes over. `z-10` keeps it above the
          cards (whose stripe is a positioned ::before). */}
      <button
        type="button"
        onClick={() => onToggle(city)}
        aria-expanded={!collapsed}
        className="band sticky top-0 z-10 flex w-full cursor-pointer items-center justify-between hover:text-text"
      >
        <span>
          {collapsed ? '+ ' : '- '}// {city.toLowerCase()}
        </span>
        <span className="text-text-dim">{jobs.length}</span>
      </button>

      {!collapsed &&
        (view === 'line' ? (
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
        ))}
    </section>
  )
}
