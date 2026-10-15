import { useEffect, useRef } from 'react'
import type { Job } from '../types'
import MetaLine from './MetaLine'
import { textButton } from './styles'

type Props = {
  job: Job
  // Applied since the last sync: [ undo ] instead of a plain "applied".
  undoable: boolean
  onClose: () => void
  onOpen: (job: Job) => void
  onMarkApplied: (job: Job) => void
  onUndo: (job: Job) => void
}

// The detail card: full company and title, everything else we know about a
// posting, and the apply action. Closes on Esc or a click outside the panel.
export default function JobDetail({ job, undoable, onClose, onOpen, onMarkApplied, onUndo }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Same pattern as FilterMenu: document-level listeners that exist only
  // while the panel is mounted, removed by the cleanup function.
  useEffect(() => {
    // Move keyboard focus into the panel so Tab starts from its buttons.
    panelRef.current?.focus()
    function onPointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // Optional rows: only the ones this posting has.
  const extra: [string, string | null][] = [
    ['req id', job.req_id],
    ['source', job.source],
    ['borderline', job.borderline ? (job.borderline_reason ?? 'yes') : null],
  ]

  return (
    // `fixed inset-0` covers the window so the panel can be centred on it;
    // `pointer-events-none` lets clicks pass through the empty area to the
    // page (the outside-click listener then closes the panel), while the
    // panel itself turns them back on. `z-30` is above the sticky city bands
    // (z-10) and the filter panel (z-20).
    <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`${job.company} — ${job.title}`}
        tabIndex={-1}
        className="pointer-events-auto w-full max-w-lg border border-rule bg-bg-card outline-none"
      >
        <div className="px-6 pt-5 pb-4">
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
      </div>
    </div>
  )
}
