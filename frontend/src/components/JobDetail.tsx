import { useEffect, useRef, useState, type TransitionEvent } from 'react'
import type { Job } from '../types'
import { prefersReducedMotion } from '../lib/motion'
import MetaLine from './MetaLine'
import { textButton } from './styles'

type Props = {
  job: Job
  // Applied since the last sync: [ undo ] instead of a plain "applied".
  undoable: boolean
  // Called once the drawer has finished sliding out; the parent unmounts it.
  onClose: () => void
  onOpen: (job: Job) => void
  onMarkApplied: (job: Job) => void
  onUndo: (job: Job) => void
  onViewPipeline: () => void
}

// The detail drawer: slides in from the right over a dimmed list. Closes on
// Esc or a click on the dimmed area, sliding back out first.
//
// Sliding *in* is pure CSS (`@starting-style` on `.drawer` in index.css).
// Sliding *out* needs the drawer to stay on screen while it animates, so
// closing is two steps: set `closing` (CSS slides it away), then when that
// transition ends tell the parent to unmount it.
export default function JobDetail({ job, undoable, onClose, onOpen, onMarkApplied, onUndo, onViewPipeline }: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)

  // With reduced motion there's no transition, so `transitionend` would
  // never fire; close straight away instead.
  function close() {
    if (prefersReducedMotion()) onClose()
    else setClosing(true)
  }

  function onTransitionEnd(e: TransitionEvent) {
    // transitionend bubbles up from children too, and fires once per
    // property; only the drawer's own slide counts.
    if (closing && e.target === e.currentTarget && e.propertyName === 'transform') onClose()
  }

  // Safety net: if `transitionend` never arrives (an interrupted
  // transition doesn't fire it), unmount anyway after twice the duration,
  // so an invisible drawer can never sit on top of the list eating clicks.
  useEffect(() => {
    if (!closing) return
    const t = setTimeout(onClose, 400)
    return () => clearTimeout(t)
  }, [closing, onClose])

  // Move keyboard focus into the drawer once, when it opens, so Tab starts
  // from its buttons.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // Esc closes. No dependency list: `close` is a new function every render,
  // so the listener is swapped for a fresh one each time (cheap) and never
  // calls a stale `close`.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  // Optional rows: only the ones this posting has.
  const extra: [string, string | null][] = [
    ['req id', job.req_id],
    ['source', job.source],
    ['borderline', job.borderline ? (job.borderline_reason ?? 'yes') : null],
  ]

  return (
    <>
      {/* The dimmed layer over the list. It catches the "outside" click, so
          no document-level pointer listener is needed. */}
      <div className="drawer-backdrop fixed inset-0 z-30" data-closing={closing} onClick={close} aria-hidden />
      <aside
        ref={panelRef}
        role="dialog"
        aria-label={`${job.company} — ${job.title}`}
        tabIndex={-1}
        data-closing={closing}
        onTransitionEnd={onTransitionEnd}
        className="drawer fixed top-0 right-0 bottom-0 z-40 flex w-full max-w-md flex-col overflow-y-auto border-l border-rule bg-bg-card outline-none"
      >
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-company leading-tight lowercase">{job.company}</h2>
          <p className="mt-2 text-sub leading-snug text-text-muted">{job.title}</p>
          <p className="mt-3 text-meta text-text-dim">
            <MetaLine job={job} />
          </p>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 border-t border-rule px-6 py-3 text-meta">
          {extra.map(
            ([label, value]) =>
              value && (
                <div key={label} className="contents">
                  <dt className="text-text-dim">{label}</dt>
                  <dd className="m-0 text-text-muted">{value}</dd>
                </div>
              ),
          )}
          <dt className="text-text-dim">first seen</dt>
          <dd className="m-0 text-text-muted">{job.first_seen ?? '—'}</dd>
          <dt className="text-text-dim">last seen</dt>
          <dd className="m-0 text-text-muted">{job.last_seen ?? '—'}</dd>
        </dl>

        <div className="flex justify-between border-t border-rule px-6 py-3 text-meta">
          <button
            type="button"
            onClick={() => onOpen(job)}
            disabled={!job.url}
            className={`${textButton} text-text-muted disabled:cursor-default disabled:text-text-dim`}
          >
            [ open posting ]
          </button>
          {!job.applied ? (
            <button type="button" onClick={() => onMarkApplied(job)} className={`${textButton} text-text-muted`}>
              [ mark applied ]
            </button>
          ) : undoable ? (
            <button type="button" onClick={() => onUndo(job)} className={`${textButton} text-text-muted`}>
              applied · [ undo ]
            </button>
          ) : (
            <span className="text-text-dim">applied</span>
          )}
        </div>

        {job.applied && (
          <div className="border-t border-rule px-6 py-3 text-meta">
            <button type="button" onClick={onViewPipeline} className={`${textButton} text-text-muted`}>
              view in pipeline →
            </button>
          </div>
        )}
      </aside>
    </>
  )
}
