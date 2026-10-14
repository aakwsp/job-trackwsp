import type { Job } from '../types'
import JobRow from './JobRow'

type Props = {
  city: string
  jobs: Job[]
  collapsed: boolean
  onToggle: (city: string) => void
  onOpen: (job: Job) => void
  onToggleApplied: (job: Job) => void
}

export default function CityGroup({ city, jobs, collapsed, onToggle, onOpen, onToggleApplied }: Props) {
  return (
    <section>
      {/* The band itself is the collapse control. It's a <button> rather
          than a clickable <div> so it gets keyboard focus and Enter/Space
          for free. `w-full` because buttons shrink to their content. */}
      <button
        type="button"
        onClick={() => onToggle(city)}
        aria-expanded={!collapsed}
        className="band flex w-full cursor-pointer items-center justify-between hover:text-text"
      >
        <span>
          {collapsed ? '+ ' : '- '}// {city.toLowerCase()}
        </span>
        <span className="text-text-dim">{jobs.length}</span>
      </button>

      {!collapsed && (
        <ul className="m-0 list-none p-0">
          {jobs.map((job) => (
            // `key` lets React match rows across re-renders (e.g. after a
            // filter change) by job id instead of by position.
            <JobRow key={job.id} job={job} onOpen={onOpen} onToggleApplied={onToggleApplied} />
          ))}
        </ul>
      )}
    </section>
  )
}
