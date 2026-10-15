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

// LINE view: one posting per row. No scroll reveal: rows appear at once. Same `.card` class as the card views, so
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
      {/* Meta columns anchored on the dot:
            [city, right-aligned] · [date, left-aligned] [labels, left-aligned]
          Every column has a fixed width, so the dot, the start of the date
          and the start of the labels sit at the same x on every row. Widths
          are in `ch` (one character's width): Space Mono is monospaced, so a
          `ch` is exact, and it scales with the text.
          - city: 12ch, the longest city in the data ("cole harbour").
          - date: 10ch, "YYYY-MM-DD"; "rolling" is shorter.
          - labels: room for the widest combination — "30+ days",
            "borderline" and "closing soon" (30ch of text) plus each label's
            padding and border and the gaps between them. A new flag in
            FLAGS would need this widened. */}
      <span className="flex shrink-0 items-center text-meta text-text-dim">
        <span className="w-[12ch] truncate text-right" title={job.city ?? undefined}>
          {job.city?.toLowerCase() ?? '—'}
        </span>
        <span className="w-[3ch] text-center">·</span>
        <span className="w-[10ch]">{dateText(job)}</span>
        <span className="ml-4 flex w-[38ch] gap-2">
          <Labels job={job} />
        </span>
      </span>
      <StatusMarks job={job} onOpen={onOpen} />
    </div>
  )
}
