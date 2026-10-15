import { useEffect, useId, useRef, useState, type ReactNode, type TransitionEvent } from 'react'
import type { Job } from '../types'
import { agoText, flagSlots, localYmd, statusInfo, timeline } from '../lib/jobs'
import { prefersReducedMotion } from '../lib/motion'
import MetaLine from './MetaLine'

type Props = {
  job: Job
  // Called once the drawer has finished sliding out; the parent unmounts it.
  onClose: () => void
  onOpen: (job: Job) => void
  onMarkApplied: (job: Job) => void
  onUndo: (job: Job) => void
  onViewPipeline: () => void
  // Rejects with a message if the save failed.
  onSaveNotes: (job: Job, body: string) => Promise<void>
}

// The detail drawer: slides in from the right over a dimmed list. Closes on
// Esc, [ × ] or a click on the dimmed area, sliding back out first. The
// expand button swaps it for a larger centred layout with a timeline.
//
// Sliding *in* is pure CSS (`@starting-style` on `.drawer` / `.peek` in
// index.css). Sliding *out* needs the panel to stay on screen while it
// animates, so closing is two steps: set `closing` (CSS slides it away),
// then when that transition ends tell the parent to unmount it.
export default function JobDetail({
  job,
  onClose,
  onOpen,
  onMarkApplied,
  onUndo,
  onViewPipeline,
  onSaveNotes,
}: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // The textarea's text lives here, not in the job, so typing doesn't touch
  // App's state on every keystroke. `saved` remembers what the DB has, so a
  // blur with nothing changed doesn't write. A ref, because changing it
  // shouldn't re-render.
  const [notes, setNotes] = useState(job.notes ?? '')
  const saved = useRef(job.notes ?? '')
  const [notesError, setNotesError] = useState<string | null>(null)
  // A unique id to tie the // notes <label> to its textarea.
  const notesId = useId()

  function saveNotes() {
    if (notes === saved.current) return
    const previous = saved.current
    saved.current = notes
    onSaveNotes(job, notes).then(
      () => setNotesError(null),
      (e) => {
        // Forget the "saved" mark, so the next blur tries again.
        saved.current = previous
        setNotesError(String(e))
      },
    )
  }

  // Every way out of the drawer saves first: Esc while typing never fires
  // the textarea's blur before the drawer goes away.
  function close() {
    saveNotes()
    // With reduced motion there's no transition, so `transitionend` would
    // never fire; close straight away instead.
    if (prefersReducedMotion()) onClose()
    else setClosing(true)
  }

  function viewPipeline() {
    saveNotes()
    onViewPipeline()
  }

  function onTransitionEnd(e: TransitionEvent) {
    // transitionend bubbles up from children too, and fires once per
    // property; only the panel's own slide counts.
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

  // Move keyboard focus into the panel when it opens, and again on expand /
  // collapse (that's a new element, and the old one took focus with it).
  useEffect(() => {
    panelRef.current?.focus()
  }, [expanded])

  // Shortcuts. They only exist while this component is mounted, i.e. while
  // the drawer is open. No dependency list: the handler reads the current
  // `job` and functions, so it's swapped for a fresh one every render
  // (cheap) instead of ever calling a stale one.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        close()
        return
      }
      // Leave ctrl/alt combos (ctrl +/- is the UI scale) and held keys alone.
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      // While typing a note, letters are text, not shortcuts.
      if (e.target instanceof Element && e.target.closest('textarea, input')) return
      if (e.key === 'o' && job.url) onOpen(job)
      else if (e.key === 'a' && !job.applied) onMarkApplied(job)
      else if (e.key === 'u' && job.applied) onUndo(job)
      else if (e.key === 'p' && job.applied) viewPipeline()
      else return
      // Only for keys we handled: stops the browser doing anything else
      // with them (like type-ahead find).
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  const status = statusInfo(job)
  const keys = [
    job.url && 'o open',
    job.applied ? 'p pipeline' : 'a mark applied',
    job.applied && 'u undo',
    'esc close',
  ]
    .filter(Boolean)
    .join(' · ')

  // Pieces shared by both layouts. Plain JSX values rather than components:
  // they're placed in different spots, but always rendered the same way.
  const marks = (
    <div className="ml-auto flex items-center gap-2">
      {flagSlots(job).map(({ flag, on }) =>
        on ? (
          <span key={flag.key} className="flag mark-xs" data-color={flag.color} title={flag.hint} aria-label={flag.hint} />
        ) : (
          <span key={flag.key} className="flag mark-xs" aria-hidden />
        ),
      )}
      <span className="marker mark-sm mx-1" data-color={status.color} title={status.label} aria-label={status.label} />
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        aria-label={expanded ? 'collapse to side panel' : 'expand to full view'}
        className={ghostButton}
      >
        [<ExpandIcon collapse={expanded} />]
      </button>
      <button type="button" onClick={close} aria-label="close detail panel" className={ghostButton}>
        [ × ]
      </button>
    </div>
  )

  const record = `// record ${job.req_id ?? job.company.toLowerCase()}`

  const details = (
    <dl className={`m-0 grid ${expanded ? 'grid-cols-[10rem_minmax(0,1fr)]' : 'grid-cols-[8.5rem_minmax(0,1fr)]'}`}>
      <Row label="req id" first>
        {job.req_id ?? <span className="text-text-muted">— not listed</span>}
      </Row>
      <Row label="source">{job.source ?? <span className="text-text-muted">—</span>}</Row>
      <Row label="first seen">
        <Dated ymd={job.first_seen} />
      </Row>
      <Row label="last seen">
        <Dated ymd={job.last_seen} />
      </Row>
      {job.borderline && (
        <Row label="borderline">
          <span className="text-blue">{job.borderline_reason ?? 'yes'}</span>
        </Row>
      )}
    </dl>
  )

  const appliedLine = job.applied && (
    <div className="mb-2 flex items-center gap-2.5 text-meta">
      <span className="marker mark-xs" data-color="green" aria-hidden />
      <span className="text-green">applied {job.applied_at ? localYmd(job.applied_at) : ''}</span>
      {job.applied_at && <span className="text-text-muted">· {agoText(localYmd(job.applied_at))}</span>}
      <button type="button" onClick={() => onUndo(job)} className={`${ghostButton} ml-auto text-micro`}>
        [ undo ]
      </button>
    </div>
  )

  const openButton = (
    <button
      type="button"
      onClick={() => onOpen(job)}
      disabled={!job.url}
      className={`${outlineButton} disabled:cursor-default disabled:text-text-dim`}
    >
      [ open posting ↗ ]
    </button>
  )

  const statusButton = job.applied ? (
    <button type="button" onClick={viewPipeline} className={outlineButton}>
      [ view in pipeline ]
    </button>
  ) : (
    <button type="button" onClick={() => onMarkApplied(job)} className={primaryButton}>
      [ mark applied ]
    </button>
  )

  const keyHint = <p className="mt-3 text-micro leading-relaxed text-text-dim">{keys}</p>

  const notesBand = (
    <Band pad={expanded ? 'px-12 pl-[3.1875rem]' : undefined}>
      <label htmlFor={notesId}>// notes</label>
      <span className={`ml-auto normal-case tracking-normal ${notesError ? 'text-pink' : 'text-text-dim'}`}>
        {notesError ? `not saved: ${notesError}` : 'plain text · saved on blur'}
      </span>
    </Band>
  )
  const notesField = (
    <textarea
      id={notesId}
      value={notes}
      onChange={(e) => setNotes(e.target.value)}
      onBlur={saveNotes}
      placeholder="write something to future you…"
      // `flex-1` + `min-h`: the box grows to fill whatever height is left
      // at the bottom of the panel, but never shrinks below a usable size.
      className={`w-full flex-1 resize-y border border-rule-strong bg-bg text-text outline-none placeholder:text-text-dim focus-visible:border-text-muted ${
        expanded ? 'min-h-[12.5rem] px-4 py-3.5 text-[0.78125rem] leading-[1.75]' : 'min-h-[8.75rem] px-3.5 py-3 text-meta leading-[1.7]'
      }`}
    />
  )

  const endOfRecord = (
    <p aria-hidden className="pt-6 pb-5 text-center text-micro tracking-[0.22em] text-text-dim">
      — end of record —
    </p>
  )

  // The 3px status stripe down the left edge. `data-color` sets `--c` on
  // it (index.css), and `bg-(--c)` is Tailwind v4 for `background: var(--c)`.
  const stripe = <div aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-(--c)" data-color={status.color} />

  const panelProps = {
    ref: panelRef,
    role: 'dialog',
    'aria-label': `${job.company} — ${job.title}`,
    tabIndex: -1,
    'data-closing': closing,
    onTransitionEnd,
  } as const

  return (
    <>
      {/* The dimmed layer over the list. It catches the "outside" click, so
          no document-level pointer listener is needed. */}
      <div className="drawer-backdrop fixed inset-0 z-30" data-closing={closing} onClick={close} aria-hidden />

      {!expanded ? (
        <aside
          key="drawer"
          {...panelProps}
          className="drawer fixed top-0 right-0 bottom-0 z-40 flex w-[40%] max-w-full min-w-[31.25rem] flex-col overflow-y-auto border-l border-rule-strong bg-bg-hover outline-none"
        >
          {stripe}
          <header className="border-b border-rule pt-[1.125rem] pr-8 pb-[1.375rem] pl-[2.1875rem]">
            <div className="mb-[1.375rem] flex items-center gap-3">
              <p className="text-micro tracking-[0.22em] text-text-muted uppercase">{record}</p>
              {marks}
            </div>
            <h1 className="text-record leading-[0.95] tracking-[-0.01em] lowercase">{job.company}</h1>
            <p className="mt-3 text-sub leading-normal tracking-[0.02em]">{job.title}</p>
          </header>

          <div className="border-b border-rule py-3.5 pr-8 pl-[2.1875rem] text-meta text-text-muted">
            <MetaLine job={job} />
          </div>

          <section className="mt-6">
            <Band>
              <h2 className="font-mono">// details</h2>
            </Band>
            <div className="pt-1.5 pr-8 pl-[2.1875rem] text-meta">{details}</div>
          </section>

          <section className="mt-6">
            <Band>
              <h2 className="font-mono">// actions</h2>
            </Band>
            <div className="pt-4 pr-8 pl-[2.1875rem]">
              {appliedLine}
              <div className="flex flex-wrap gap-2">
                {openButton}
                {statusButton}
              </div>
              {keyHint}
            </div>
          </section>

          <section className="mt-6 flex flex-1 flex-col">
            {notesBand}
            <div className="flex flex-1 flex-col pt-4 pr-8 pl-[2.1875rem]">{notesField}</div>
          </section>

          {endOfRecord}
        </aside>
      ) : (
        <aside
          key="peek"
          {...panelProps}
          // Centred with `inset-x-0` + `mx-auto` rather than the usual
          // `left-1/2 -translate-x-1/2`, because `transform` is already
          // spoken for by the entrance animation (.peek in index.css).
          className="peek fixed inset-x-0 top-10 bottom-10 z-40 mx-auto flex w-[70rem] max-w-[calc(100%-4rem)] flex-col overflow-y-auto border border-rule-strong bg-bg-hover outline-none"
        >
          {stripe}
          <div className="flex h-11 shrink-0 items-center gap-3 border-b border-rule pr-5 pl-[2.1875rem]">
            <p className="text-micro tracking-[0.12em] text-text-muted uppercase">{record}</p>
            <p className="text-micro text-text-dim lowercase">
              jobs / {job.city ?? 'unknown'} / {job.company}
            </p>
            {marks}
          </div>

          <header className="shrink-0 pt-11 pr-12 pb-[1.875rem] pl-[3.1875rem]">
            <h1 className="text-record-xl leading-[0.95] tracking-[-0.01em] lowercase">{job.company}</h1>
            <p className="mt-3.5 text-body leading-normal tracking-[0.02em]">{job.title}</p>
            <div className="mt-[1.375rem] text-meta text-text-muted">
              <MetaLine job={job} />
            </div>
          </header>

          {/* Two columns: details + notes on the left, actions + timeline
              in a fixed 340px rail on the right. `minmax(0, 1fr)` instead
              of `1fr` lets the left column shrink below its content's
              natural width, so a long title wraps instead of overflowing. */}
          <div className="grid flex-1 grid-cols-[minmax(0,1fr)_21.25rem]">
            <div className="flex min-w-0 flex-col">
              <section>
                <Band pad="px-12 pl-[3.1875rem]" noTop>
                  <h2 className="font-mono">// details</h2>
                </Band>
                <div className="pt-1.5 pr-12 pl-[3.1875rem] text-[0.78125rem]">{details}</div>
              </section>
              <section className="mt-7 flex flex-1 flex-col">
                {notesBand}
                <div className="flex flex-1 flex-col pt-[1.125rem] pr-12 pb-8 pl-[3.1875rem]">{notesField}</div>
              </section>
            </div>

            <aside className="flex flex-col border-l border-rule">
              <section>
                <Band pad="px-6" noTop>
                  <h2 className="font-mono">// actions</h2>
                </Band>
                {/* `[&>button]:...`: an arbitrary variant that styles every
                    direct child button, so both stack full-width with
                    left-aligned text without repeating the classes. */}
                <div className="flex flex-col gap-2 px-6 pt-[1.125rem] pb-6 [&>button]:justify-start">
                  {appliedLine}
                  {statusButton}
                  {openButton}
                  {keyHint}
                </div>
              </section>
              <section>
                <Band pad="px-6">
                  <h2 className="font-mono">// timeline</h2>
                </Band>
                <ol className="m-0 flex list-none flex-col gap-3 px-6 pt-4 pb-6 text-[0.71875rem]">
                  {timeline(job).map((t) => (
                    <li key={t.label} className="flex items-center gap-2.5">
                      <span
                        aria-hidden
                        className={`${t.shape === 'diamond' ? 'marker' : 'flag'} mark-xs ${t.color ? '' : 'bg-text-muted'}`}
                        data-color={t.color ?? undefined}
                      />
                      <span className="text-text-muted">{t.date}</span>
                      <span>{t.label}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </aside>
          </div>

          <div className="shrink-0 border-t border-rule">{endOfRecord}</div>
        </aside>
      )}
    </>
  )
}

// Button looks. Full literals so Tailwind's source scan sees every class.
// The two bordered ones are 44px tall, a comfortable click target.
const ghostButton = 'inline-flex h-8 cursor-pointer items-center px-1 text-meta text-text-muted hover:text-text'
const outlineButton =
  'inline-flex h-11 cursor-pointer items-center border border-rule-strong px-4 text-meta text-text hover:border-text-muted hover:bg-bg'
// The one filled button in the drawer. `hover:opacity-90` lightens it a
// touch against the dark panel without inventing a new colour.
const primaryButton =
  'inline-flex h-11 cursor-pointer items-center border border-text bg-text px-[1.125rem] text-meta font-bold text-bg hover:opacity-90'

// A `// section` header band: full width, 36px, hairlines above and below.
// `pad` overrides the side padding for the wider expanded layout; `noTop`
// drops the top hairline where something directly above already draws one.
function Band({ children, pad, noTop = false }: { children: ReactNode; pad?: string; noTop?: boolean }) {
  return (
    <div
      className={`flex h-9 items-center border-b border-rule bg-bg text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase ${
        noTop ? '' : 'border-t'
      } ${pad ?? 'pr-8 pl-[2.1875rem]'}`}
    >
      {children}
    </div>
  )
}

// One label/value pair in // details. Every row but the first gets a
// hairline on top, on both cells, so the line runs the full width.
function Row({ label, first = false, children }: { label: string; first?: boolean; children: ReactNode }) {
  const rule = first ? '' : 'border-t border-rule'
  return (
    <>
      <dt className={`py-2 text-text-muted ${rule}`}>{label}</dt>
      <dd className={`m-0 py-2 ${rule}`}>{children}</dd>
    </>
  )
}

function Dated({ ymd }: { ymd: string | null }) {
  if (!ymd) return <span className="text-text-muted">—</span>
  return (
    <>
      {ymd} <span className="text-text-muted">· {agoText(ymd)}</span>
    </>
  )
}

// Two corner arrows: pointing out to expand, in to collapse.
function ExpandIcon({ collapse }: { collapse: boolean }) {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="square"
      className="mx-1.5"
    >
      <path d={collapse ? 'M11 5H7V1M7 5l4-4M1 7h4v4M5 7l-4 4' : 'M7 1h4v4M11 1L7 5M5 11H1V7M1 11l4-4'} />
    </svg>
  )
}
