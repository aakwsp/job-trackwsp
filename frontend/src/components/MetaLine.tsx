import type { Job } from '../types'
import { cityText, dateText, labelsFor } from '../lib/jobs'

// The status labels for one posting (see `labelsFor`), built from the same
// FLAGS / STATUSES entries as the markers.
export function Labels({ job, short = false }: { job: Job; short?: boolean }) {
  return (
    <>
      {labelsFor(job, short).map((l) => (
        <span key={l.key} className="label" data-color={l.color}>
          {l.text}
        </span>
      ))}
    </>
  )
}

type Props = {
  job: Job
  short?: boolean
  // The posting's other hubs, when it's listed in several (JT-38).
  others?: string[]
}

// city · date-or-rolling  [square labels] [diamond label]
// Used by the card views and the detail card. LINE lays the same pieces out
// in columns instead (see JobLine).
export default function MetaLine({ job, short = false, others = [] }: Props) {
  return (
    // `flex-wrap`: the labels follow the date on the same line, and any that
    // don't fit drop to a line beneath (left-aligned) instead of being cut.
    // Each label is its own flex item, so they wrap one at a time.
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>
        {cityText(job)}
        <OtherHubs hubs={others} /> · {dateText(job)}
      </span>
      <Labels job={job} short={short} />
    </span>
  )
}

// " + kw": a posting listed in several hubs, said quietly so the copies
// read as one posting. The title spells it out on hover.
export function OtherHubs({ hubs }: { hubs: string[] }) {
  if (hubs.length === 0) return null
  return (
    <span className="text-text-dim" title={`one posting, also under // ${hubs.join(', // ')}`}>
      {' '}
      + {hubs.join(' + ')}
    </span>
  )
}
