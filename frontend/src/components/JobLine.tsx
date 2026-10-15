import type { Job } from '../types'
import { LINE_TITLE_MAX, clipTitle, dateText, stripeColor } from '../lib/jobs'
import { Labels } from './MetaLine'
import { clickable } from './clickable'
import StatusMarks from './StatusMarks'

type Props = {
  job: Job
  onSelect: (job: Job) => void
  onOpen: (job: Job) => void
}

// LINE view: one posting per row. Same `.card` class as the card views, so
// the stripe, hover highlight and applied dimming match.
export default function JobLine({ job, onSelect, onOpen }: Props) {
  return (
    <div
      {...clickable(() => onSelect(job))}
      className="card flex cursor-pointer items-center gap-4 py-2 pr-5 pl-6"
      data-color={stripeColor(job)}
      data-applied={job.applied}
    >
      {/* The title is capped at LINE_TITLE_MAX characters and the company is
          never cut. `truncate` + `min-w-0` stay only as a safety net for a
          very narrow window, so the meta can't be pushed off-screen. */}
      <p className="min-w-0 flex-1 truncate">
        <span className="font-serif text-company-line lowercase">{job.company}</span>
        <span className="ml-3 text-sub text-text-muted" title={job.title}>
          {clipTitle(job.title, LINE_TITLE_MAX)}
        </span>
      </p>
      {/* Three fixed-width, right-aligned columns, so every row's city,
          date and labels start at the same x and the dates line up no
          matter how many labels a row has. Widths are in `ch` (the width of
          one character): Space Mono is monospaced, so a `ch` is exact, and
          it scales with the text.
          - city: 12ch, the longest city in the data ("cole harbour").
          - date: 10ch, "YYYY-MM-DD"; "rolling" is shorter.
          - labels: room for the widest combination — "30+ days",
            "borderline" and "closing soon" (30ch of text) plus each label's
            padding and border and the gaps between them. A new flag in
            FLAGS would need this widened. */}
      <span className="flex shrink-0 items-center gap-4 text-meta text-text-dim">
        <span className="w-[12ch] truncate text-right" title={job.city ?? undefined}>
          {job.city?.toLowerCase() ?? '—'}
        </span>
        <span className="w-[10ch] text-right">{dateText(job)}</span>
        <span className="flex w-[38ch] justify-end gap-2">
          <Labels job={job} />
        </span>
      </span>
      <StatusMarks job={job} onOpen={onOpen} />
    </div>
  )
}
