import type { Job } from '../types'
import { CLOSING_DAYS, daysLeft, rowStatus } from '../lib/jobs'

type Props = {
  job: Job
  onOpen: (job: Job) => void
  onToggleApplied: (job: Job) => void
}

// "6d left" only while it's urgent; otherwise the date alone is enough.
function deadlineLabel(deadline: string | null): string | null {
  if (!deadline) return null
  const days = daysLeft(deadline)
  if (days === null || days < 0 || days > CLOSING_DAYS) return `due ${deadline}`
  return `due ${deadline} (${days === 0 ? 'today' : `${days}d left`})`
}

export default function JobRow({ job, onOpen, onToggleApplied }: Props) {
  // `filter(Boolean)` drops the nulls so missing fields don't leave a
  // dangling " · ".
  const meta = [
    job.city?.toLowerCase(),
    deadlineLabel(job.deadline),
    job.req_id && `#${job.req_id}`,
    job.source,
    job.borderline && (job.borderline_reason ? `borderline: ${job.borderline_reason}` : 'borderline'),
  ].filter(Boolean)

  return (
    // `.row` (index.css) owns the grid, hairline and the 3px edge picked by
    // `data-status`; the utilities here only add the column layout.
    // `1fr auto` = text takes the remaining width, the toggle sizes to fit.
    <li className="row grid-cols-[1fr_auto] gap-x-6" data-status={rowStatus(job)}>
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => onOpen(job)}
          disabled={!job.url}
          title={job.url ?? 'no url'}
          className="cursor-pointer text-left hover:underline disabled:cursor-default disabled:no-underline"
        >
          <span className="font-serif text-[15px] text-text">{job.company}</span>
          <span className="ml-3 text-text-muted">{job.title}</span>
        </button>
        <p className="text-[11px] text-text-dim">{meta.join(' · ')}</p>
      </div>

      <button
        type="button"
        onClick={() => onToggleApplied(job)}
        aria-pressed={job.applied}
        className="cursor-pointer self-center text-[11px] whitespace-nowrap text-text-muted hover:text-text"
      >
        {job.applied ? '[x] applied' : '[ ] apply'}
      </button>
    </li>
  )
}
