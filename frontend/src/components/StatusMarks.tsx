import type { Job } from '../types'
import { flagSlots, statusInfo } from '../lib/jobs'

type Props = {
  job: Job
  onOpen: (job: Job) => void
}

// Top-right of a card (end of a line): the flag squares in FLAGS order, the
// diamond, then ↗. The diamond and the card's stripe both come from
// `statusInfo`, so they can't disagree.
//
// An absent flag still renders its `.flag` box, just with no `data-color`,
// so it has no background: an invisible spacer that keeps every later mark
// in the same x position on every card. `aria-hidden` keeps screen readers
// from announcing the empty box.
export default function StatusMarks({ job, onOpen }: Props) {
  const status = statusInfo(job)
  return (
    <div className="flex shrink-0 items-center gap-2 text-meta text-text-muted">
      {flagSlots(job).map(({ flag, on }) =>
        on ? (
          <span key={flag.key} className="flag" data-color={flag.color} title={flag.hint} aria-label={flag.hint} />
        ) : (
          <span key={flag.key} className="flag" aria-hidden />
        ),
      )}
      <span className="marker" data-color={status.color} title={status.label} />
      <button
        type="button"
        // The whole card is clickable (opens the detail card). Clicks bubble
        // up through ancestors, so without stopPropagation this ↗ would open
        // the browser *and* the detail card.
        onClick={(e) => {
          e.stopPropagation()
          onOpen(job)
        }}
        disabled={!job.url}
        aria-label="open posting"
        title={job.url ?? 'no url'}
        className="ml-1 cursor-pointer hover:text-text disabled:cursor-default disabled:text-text-dim"
      >
        ↗
      </button>
    </div>
  )
}
