import type { AppStatus, TimelineNode } from '../types'
import { eventColor, eventLabel, localDay } from '../lib/inbox'
import { stageColor } from '../lib/applications'

// The one timeline (JT-18), the same in INBOX and in the record's
// application, emails and summary tabs: one application's history,
// oldest → newest, on a hairline.
//   ◆ diamond = an email, in its stage colour (rejection dim, follow-up and
//     scheduling muted); filled once applied (auto / confirmed), hollow
//     while it's still in checking; a ring around the open one.
//   ■ square = an event that isn't an email: the posting first seen, applied
//     by hand, a stage you moved it to yourself.
// An email that moved the stage is that event, so it's only drawn once.
// `large` adds a label under each date. Scrolls sideways if it's long.

type Props = {
  nodes: TimelineNode[]
  currentId?: number | null
  large?: boolean
  onPick: (emailId: number) => void
}

/** A square's label: what happened, from the event type. */
function eventNodeLabel(type: string | null): string {
  switch (type) {
    case 'first_seen':
      return 'first seen'
    case 'applied':
      return 'applied by hand'
    case 'rejected':
      return 'marked rejected'
    case 'withdrawn':
      return 'withdrawn'
    default:
      return `moved to ${type ?? '?'}`
  }
}

export default function Timeline({ nodes, currentId = null, large = false, onPick }: Props) {
  return (
    <div role="group" aria-label="timeline, oldest to newest" className="overflow-x-auto overflow-y-hidden [scrollbar-width:thin]">
      <div className={`relative flex w-max min-w-full ${large ? 'px-5 pt-[1.625rem] pb-[1.375rem]' : 'px-5 pt-5 pb-4'}`}>
        {/* The line through the middle of every node box. */}
        <div aria-hidden className={`absolute right-8 left-8 h-px bg-rule-strong ${large ? 'top-[2.5rem]' : 'top-[1.9375rem]'}`} />
        {nodes.map((n, i) => {
          const email = n.kind === 'email'
          // Emails are coloured by what the email says (eventColor: applied
          // sand, ...), events by the stage they set (stageColor).
          const color = email ? eventColor(n.event_type) : n.event_type === 'first_seen' ? null : stageColor(n.event_type as AppStatus)
          const dim = n.event_type === 'rejection' || n.event_type === 'rejected' || n.event_type === 'withdrawn'
          const filled = !email || n.status === 'auto' || n.status === 'confirmed'
          const current = email && n.email_id === currentId
          // Colour as a class: a stage colour via --c (set by data-color),
          // closing events dim, everything else muted.
          const tone = color ? 'border-(--c)' : dim ? 'border-text-dim' : 'border-text-muted'
          const fill = !filled ? 'bg-transparent' : color ? 'bg-(--c)' : dim ? 'bg-text-dim' : 'bg-text-muted'
          // Diamonds are drawn a touch bigger than squares: a rotated
          // square reads smaller than an upright one of the same size.
          const size = email ? (large ? 'size-[0.8125rem]' : 'size-2.5') : large ? 'size-[0.5625rem]' : 'size-2'
          const label = email ? eventLabel(n.event_type) : eventNodeLabel(n.event_type)
          const day = localDay(n.at && n.at.length === 10 ? `${n.at}T12:00:00` : n.at)
          const inner = (
            <>
              <span className={`flex items-center justify-center bg-bg-hover ${large ? 'size-7' : 'size-[1.375rem]'} ${current ? 'outline outline-text' : ''}`}>
                <span className={`block border ${size} ${tone} ${fill} ${email ? 'rotate-45' : ''}`} />
              </span>
              <span className={`mt-2 text-[0.65625rem] ${current ? 'text-text' : ''}`}>{day}</span>
              {large && <span className={`mt-1 text-[0.65625rem] ${color ? 'text-(--c)' : 'text-text-muted'}`}>{label}</span>}
            </>
          )
          const box = `relative flex shrink-0 flex-col items-center text-text-muted ${large ? 'w-[9.375rem]' : 'w-28'}`
          // Only emails open something; an event is just a mark.
          return email && n.email_id !== null ? (
            <button
              key={`e${n.email_id}`}
              type="button"
              onClick={() => onPick(n.email_id!)}
              aria-current={current || undefined}
              aria-label={`email: ${label}, ${day}${filled ? '' : ', still in checking'}`}
              data-color={color ?? undefined}
              className={`${box} cursor-pointer appearance-none bg-transparent hover:text-text`}
            >
              {inner}
            </button>
          ) : (
            <span key={`v${i}`} role="img" aria-label={`${label}, ${day}`} data-color={color ?? undefined} className={box}>
              {inner}
            </span>
          )
        })}
      </div>
    </div>
  )
}
