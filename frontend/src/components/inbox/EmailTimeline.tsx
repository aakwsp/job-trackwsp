import type { TimelineNode } from '../../types'
import { eventColor, eventLabel, localDay } from '../../lib/inbox'

// The horizontal email timeline (design/inbox, the "// timeline" track):
// one node per email matched to an application, oldest → newest, on a
// hairline. Diamonds for stage events, small squares for follow-ups and
// scheduling; filled = auto or confirmed, hollow = still in checking; a
// ring around the open one. `large` (by-job view, record emails tab) adds
// the event label under each date. Scrolls sideways if it's long.

type Props = {
  nodes: TimelineNode[]
  currentId?: number | null
  large?: boolean
  onPick: (emailId: number) => void
}

const STAGES = ['applied', 'assessment', 'interview', 'offer', 'rejection']

export default function EmailTimeline({ nodes, currentId = null, large = false, onPick }: Props) {
  return (
    <div
      role="group"
      aria-label="emails for this application, oldest to newest"
      className="overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
    >
      <div className={`relative flex w-max min-w-full ${large ? 'px-5 pt-[1.625rem] pb-[1.375rem]' : 'px-5 pt-5 pb-4'}`}>
        {/* The line through the middle of every node box. */}
        <div aria-hidden className={`absolute right-8 left-8 h-px bg-rule-strong ${large ? 'top-[2.5rem]' : 'top-[1.9375rem]'}`} />
        {nodes.map((n) => {
          const stage = n.event_type !== null && STAGES.includes(n.event_type)
          const done = n.status === 'auto' || n.status === 'confirmed'
          const color = eventColor(n.event_type)
          const rejected = n.event_type === 'rejection'
          const current = n.email_id === currentId
          // Colour as a class: a stage colour via --c, rejection dim,
          // everything else muted.
          const tone = color ? 'border-(--c)' : rejected ? 'border-text-dim' : 'border-text-muted'
          const fill = !done ? 'bg-transparent' : color ? 'bg-(--c)' : rejected ? 'bg-text-dim' : 'bg-text-muted'
          const size = stage ? (large ? 'size-[0.8125rem]' : 'size-2.5') : large ? 'size-[0.4375rem]' : 'size-1.5'
          return (
            <button
              key={n.email_id}
              type="button"
              onClick={() => onPick(n.email_id)}
              aria-current={current || undefined}
              aria-label={`${eventLabel(n.event_type)}, ${localDay(n.received_at)}${done ? '' : ', still in checking'}`}
              data-color={color ?? undefined}
              className={`relative flex shrink-0 cursor-pointer appearance-none flex-col items-center bg-transparent text-text-muted hover:text-text ${large ? 'w-[9.375rem]' : 'w-28'}`}
            >
              <span
                className={`flex items-center justify-center bg-bg-hover ${large ? 'size-7' : 'size-[1.375rem]'} ${
                  current ? 'outline outline-text' : ''
                }`}
              >
                <span className={`block border ${size} ${tone} ${fill} ${stage ? 'rotate-45' : ''}`} />
              </span>
              <span className={`mt-2 text-[0.65625rem] ${current ? 'text-text' : ''}`}>{localDay(n.received_at)}</span>
              {large && (
                <span className={`mt-1 text-[0.65625rem] ${color ? 'text-(--c)' : 'text-text-muted'}`}>{eventLabel(n.event_type)}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
