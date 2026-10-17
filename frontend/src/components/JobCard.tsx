import type { Job } from '../types'
import { stripeColor } from '../lib/jobs'
import MetaLine from './MetaLine'
import { clickable } from './clickable'
import { useReveal } from '../lib/reveal'
import StatusMarks from './StatusMarks'

type Props = {
  job: Job
  // The section it's drawn in; its other hubs get the "+ kw" marker.
  hub: string
  compact: boolean
  onSelect: (job: Job) => void
  onOpen: (job: Job) => void
}

// DEFAULT and COMPACT views. DEFAULT gets more padding and spacing, plus a
// hairline above the meta line.
export default function JobCard({ job, hub, compact, onSelect, onOpen }: Props) {
  // Rises in the first time it scrolls into view (lib/reveal.tsx). Keyed by
  // job id and section (a posting can be in two), so DEFAULT and COMPACT
  // share the "already revealed" memory.
  const { ref: revealRef, className: revealClass } = useReveal(`job:${job.id}:${hub}`)
  return (
    // `.card` (index.css) owns the shared hairlines, the 3px stripe picked
    // by `data-color`, and the dimming for `data-applied`. `flex-col` +
    // `mt-auto` pins the meta line down, so cards in the same grid row
    // (which stretch to equal height) line their meta lines up.
    <article
      {...clickable(() => onSelect(job))}
      // Lets App's hover shortcuts (a / o) find this posting.
      data-job-id={job.id}
      ref={revealRef}
      className={`card rise ${revealClass} flex cursor-pointer flex-col pr-5 pl-6 ${compact ? 'pt-3.5 pb-3' : 'pt-5 pb-4'}`}
      data-color={stripeColor(job)}
      data-applied={job.applied}
    >
      <div className="flex items-start justify-between gap-3">
        {/* `truncate` = one line + "…" on overflow. In a flex row it only
            works with `min-w-0`: a flex child won't shrink below its
            content's width by default, so there'd be nothing to cut. */}
        {/* `title` = the browser's native hover tooltip, showing the full
            string when the visible one is cut. */}
        <h3 className="min-w-0 truncate text-company leading-tight lowercase" title={job.company}>
          {job.company}
        </h3>
        <StatusMarks job={job} onOpen={onOpen} />
      </div>

      {/* The gap above the meta line lives here as a bottom margin. The meta
          row already has `mt-auto`, and a second margin-top class on it
          wouldn't add up: only one of the two would apply. */}
      {/* Cut by the card's real width, not a character count, so it adapts
          to window size and UI scale. `truncate` is Tailwind for exactly
          white-space: nowrap + overflow: hidden + text-overflow: ellipsis. */}
      <p className={`truncate text-sub leading-snug text-text-muted ${compact ? 'mt-1' : 'mt-2 mb-4'}`} title={job.title}>
        {job.title}
      </p>

      <div
        className={`mt-auto text-meta text-text-dim ${compact ? 'pt-2' : 'border-t border-rule pt-3'}`}
      >
        <MetaLine job={job} short={compact} others={job.hubs.filter((h) => h !== hub)} />
      </div>
    </article>
  )
}
