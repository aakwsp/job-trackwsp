import { useEffect, useId, useRef, useState, type ReactNode, type TransitionEvent } from 'react'
import type { Application, Job, StatusColor } from '../../types'
import { activeFlags, statusInfo } from '../../lib/jobs'
import { nextStage, stageColor } from '../../lib/applications'
import { prefersReducedMotion } from '../../lib/motion'
import { TABS, type RecordFrom, type Tab } from '../../lib/record'
import { DRAWER_PAD, ExpandIcon, Tags, ghostButton, type TagSpec } from './parts'
import { ApplicationSection, EmailsSection, PostingSection, SummarySection, type RecordModel } from './sections'

type Props = {
  // At least one of the two is set. A posting nobody applied to has no
  // `app`; something added by hand (or whose posting was hidden) has no `job`.
  job: Job | null
  app: Application | null
  from: RecordFrom
  initialTab: Tab
  // Called once the panel has finished sliding out; the parent unmounts it.
  onClose: () => void
  onOpen: (job: Job) => void
  onMarkApplied: (job: Job) => void
  // Takes back "mark applied" entirely (deletes the application).
  onUnapply: (job: Job) => void
  onAdvance: (app: Application) => void
  onReject: (app: Application) => void
  onUndoEvent: (app: Application) => void
  // Rejects with a message if the save failed.
  onSaveNotes: (body: string) => Promise<void>
}

// One record for a posting and/or its application, opened from JOBS (on the
// posting tab) or from PIPELINE (on the application tab).
//
// Drawer mode slides in from the right; the expand button swaps it for a
// larger centred page. Both show one tab at a time, and they share `tab`,
// so collapsing back keeps whichever tab was open. Only the summary lays
// out differently: two columns expanded, one in the drawer.
//
// Sliding *in* is pure CSS (`@starting-style` on `.drawer` / `.peek` in
// index.css). Sliding *out* needs the panel to stay on screen while it
// animates, so closing is two steps: set `closing` (CSS slides it away),
// then when that transition ends tell the parent to unmount it.
export default function Record({
  job,
  app,
  from,
  initialTab,
  onClose,
  onOpen,
  onMarkApplied,
  onUnapply,
  onAdvance,
  onReject,
  onUndoEvent,
  onSaveNotes,
}: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<Tab>(initialTab)

  // The textarea's text lives here, not in App, so typing doesn't touch
  // App's state on every keystroke. `saved` remembers what the DB has, so a
  // blur with nothing changed doesn't write. A ref, because changing it
  // shouldn't re-render.
  const initialNotes = (job ? job.notes : app?.notes) ?? ''
  const [notes, setNotes] = useState(initialNotes)
  const saved = useRef(initialNotes)
  const [notesError, setNotesError] = useState<string | null>(null)
  const notesId = useId()

  function saveNotes() {
    if (notes === saved.current) return
    const previous = saved.current
    saved.current = notes
    onSaveNotes(notes).then(
      () => setNotesError(null),
      (e) => {
        // Forget the "saved" mark, so the next blur tries again.
        saved.current = previous
        setNotesError(String(e))
      },
    )
  }

  // Every way out of the record saves first: Esc while typing never fires
  // the textarea's blur before the panel goes away.
  function close() {
    saveNotes()
    // With reduced motion there's no transition, so `transitionend` would
    // never fire; close straight away instead.
    if (prefersReducedMotion()) onClose()
    else setClosing(true)
  }

  function onTransitionEnd(e: TransitionEvent) {
    // transitionend bubbles up from children too, and fires once per
    // property; only the panel's own slide counts.
    if (closing && e.target === e.currentTarget && e.propertyName === 'transform') onClose()
  }

  // Safety net: if `transitionend` never arrives (an interrupted
  // transition doesn't fire it), unmount anyway after twice the duration,
  // so an invisible panel can never sit on top of the list eating clicks.
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

  // What the actions can do right now.
  const closed = app ? stageColor(app.status) === null : false
  const next = app ? nextStage(app.status) : null
  const canReject = !!app && !closed
  // [ undo ] takes back the last step. Once closed or at offer that's the
  // latest event. Fresh off [ mark applied ] (one event, linked to a
  // posting) it's the JT-32 undo: the application goes away entirely.
  const undoesEvent = !!app && (closed || app.status === 'offer')
  const unapplies = !!app && !!job && app.status === 'applied' && app.events.length <= 1
  const canUndo = undoesEvent || unapplies

  function undo() {
    if (undoesEvent && app) onUndoEvent(app)
    else if (unapplies && job) onUnapply(job)
  }

  // Shortcuts. They only exist while this component is mounted, i.e. while
  // the record is open. No dependency list: the handler reads the current
  // props, so it's swapped for a fresh one every render (cheap) instead of
  // ever calling a stale one.
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
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) setTab(TABS[n - 1])
      else if (e.key === 'o' && job?.url) onOpen(job)
      else if (e.key === 'a' && job && !app) onMarkApplied(job)
      else if (e.key === 'n' && app && next) onAdvance(app)
      else if (e.key === 'r' && app && canReject) onReject(app)
      else if (e.key === 'u' && canUndo) undo()
      else return
      // Only for keys we handled: stops the browser doing anything else
      // with them (like type-ahead find).
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  const company = job?.company ?? app?.company ?? ''
  const title = job?.title ?? app?.title ?? ''

  // Stripe, diamond and the status tag: the application's stage once there
  // is one, else the posting's own status (closing soon, rolling, ...).
  const postingStatus = job ? statusInfo(job) : null
  const color: StatusColor | null = app ? stageColor(app.status) : (postingStatus?.color ?? null)
  const statusLabel = app ? (closed ? app.status : `stage: ${app.status}`) : (postingStatus?.label ?? '')
  const tags: TagSpec[] = [
    ...(job ? activeFlags(job) : []).map((f) => ({ key: f.key, color: f.color, text: f.label })),
    app
      ? { key: 'stage', color: color ?? 'muted', text: app.status }
      : { key: 'status', color: postingStatus?.color ?? 'muted', text: postingStatus?.label ?? '' },
  ]

  const keys = [
    `1–${TABS.length} tabs`,
    job?.url && 'o open posting',
    job && !app && 'a mark applied',
    next && 'n next stage',
    canReject && 'r mark rejected',
    canUndo && 'u undo',
    'esc close',
  ]
    .filter(Boolean)
    .join(' · ')

  const m: RecordModel = {
    job,
    app,
    tags,
    next,
    canReject,
    canUndo,
    open: () => job && onOpen(job),
    markApplied: () => job && onMarkApplied(job),
    advance: () => app && onAdvance(app),
    reject: () => app && onReject(app),
    undo,
    goTo: setTab,
    notes: { id: notesId, value: notes, error: notesError, onChange: setNotes, onBlur: saveNotes },
  }

  const marks = (
    <div className="ml-auto flex items-center gap-2">
      {job &&
        activeFlags(job).map((f) => (
          <span key={f.key} className="flag mark-xs" data-color={f.color} title={f.hint} aria-label={f.hint} />
        ))}
      <span
        className={`marker mark-sm mx-1 ${color ? '' : 'bg-text-dim'}`}
        data-color={color ?? undefined}
        title={statusLabel}
        aria-label={statusLabel}
      />
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        aria-label={expanded ? 'collapse to side panel' : 'expand to full view'}
        className={ghostButton}
      >
        [<ExpandIcon collapse={expanded} />]
      </button>
      <button type="button" onClick={close} aria-label="close record" className={ghostButton}>
        [ × ]
      </button>
    </div>
  )

  const recordId = `// record ${job?.req_id ?? company.toLowerCase()}`

  // Where it was opened from: "jobs / toronto / robinhood" or
  // "pipeline / interview / robinhood".
  const crumb =
    from === 'jobs'
      ? `jobs / ${job?.city ?? 'unknown'} / ${company}`
      : `pipeline / ${app?.status ?? 'not applied'} / ${company}`

  const meta = (
    <div className="mt-4 flex flex-wrap items-center gap-x-3.5 gap-y-2">
      <p className="text-meta text-text-muted lowercase">
        {job ? (
          <>
            {job.city ?? '—'} <span className="text-text-dim">·</span> {job.deadline ? `due ${job.deadline}` : 'rolling'}
          </>
        ) : (
          'added by hand'
        )}
      </p>
      <Tags tags={tags} />
    </div>
  )

  // The 3px status stripe down the left edge. `data-color` sets `--c` on
  // it (index.css), and `bg-(--c)` is Tailwind v4 for `background: var(--c)`.
  const stripe = (
    <div
      aria-hidden
      className={`absolute inset-y-0 left-0 w-[3px] ${color ? 'bg-(--c)' : 'bg-text-dim'}`}
      data-color={color ?? undefined}
    />
  )

  const keyHint = <p className={`pt-[1.375rem] text-micro leading-relaxed text-text-dim ${DRAWER_PAD}`}>{keys}</p>
  const endOfRecord = (
    <p aria-hidden className="pt-5 pb-[1.375rem] text-center text-micro tracking-[0.22em] text-text-dim">
      — end of record —
    </p>
  )

  const panelProps = {
    ref: panelRef,
    role: 'dialog',
    'aria-label': `${company} — ${title}`,
    tabIndex: -1,
    'data-closing': closing,
    onTransitionEnd,
  } as const

  // `pl` lines the first tab's text up with the content below it (the
  // tab's own `px-3` makes up the difference).
  const tabBar = (pl: string) => (
    <div role="tablist" aria-label="record sections" className={`mt-5 flex flex-wrap border-b border-rule pr-5 ${pl}`}>
      {TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
          // `-mb-px` pulls the button's 1px underline down over the bar's
          // own bottom hairline, so the active tab's line replaces it.
          className={`-mb-px h-10 cursor-pointer border-b px-3 text-[0.71875rem] tracking-[0.04em] hover:text-text ${
            tab === t ? 'border-text text-text' : 'border-transparent text-text-muted'
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  )

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
          <header className="pt-[1.125rem]">
            <div className="pr-8 pl-[2.1875rem]">
              <div className="mb-[1.375rem] flex items-center gap-3">
                <p className="text-micro tracking-[0.22em] text-text-muted uppercase">{recordId}</p>
                <p className="text-micro text-text-dim">from {from}</p>
                {marks}
              </div>
              <h1 className="text-record leading-[0.95] tracking-[-0.01em] lowercase">{company}</h1>
              <p className="mt-3 text-[0.8125rem] leading-normal tracking-[0.02em]">{title}</p>
              {meta}
            </div>
            {tabBar('pl-[1.4375rem]')}
          </header>

          {/* `flex-1` + `flex-col`: the summary's notes box can grow to
              fill the rest of the panel. */}
          <div role="tabpanel" aria-label={tab} className="flex flex-1 flex-col">
            <Section tab={tab} m={m} pad={DRAWER_PAD} wide={false} />
          </div>

          {keyHint}
          {endOfRecord}
        </aside>
      ) : (
        <aside
          key="peek"
          {...panelProps}
          // Centred with `inset-x-0` + `mx-auto` rather than the usual
          // `left-1/2 -translate-x-1/2`, because `transform` is already
          // spoken for by the entrance animation (.peek in index.css).
          className="peek fixed inset-x-0 top-10 bottom-10 z-40 mx-auto flex w-[72.5rem] max-w-[calc(100%-4rem)] flex-col overflow-y-auto border border-rule-strong bg-bg-hover outline-none"
        >
          {stripe}
          <div className="flex h-11 shrink-0 items-center gap-3 border-b border-rule pr-5 pl-[2.1875rem]">
            <p className="text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase">{recordId}</p>
            <p className="text-[0.65625rem] text-text-dim lowercase">{crumb}</p>
            {marks}
          </div>

          <header className="shrink-0 pt-10">
            <div className="pr-12 pl-[3.1875rem]">
              <h1 className="text-record-xl leading-[0.95] tracking-[-0.01em] lowercase">{company}</h1>
              <p className="mt-3 text-[0.8125rem] leading-normal tracking-[0.02em]">{title}</p>
              {meta}
            </div>
            {tabBar('pl-[2.4375rem]')}
          </header>

          <div role="tabpanel" aria-label={tab} className="flex flex-1 flex-col">
            <Section tab={tab} m={m} pad="pr-12 pl-[3.1875rem]" wide />
          </div>

          <p className="pt-[1.375rem] pr-12 pl-[3.1875rem] text-micro leading-relaxed text-text-dim">{keys}</p>
          {endOfRecord}
        </aside>
      )}
    </>
  )
}

// The summary sets its own padding per column; the rest take `pad`.
function Section({ tab, m, pad, wide }: { tab: Tab; m: RecordModel; pad: string; wide: boolean }): ReactNode {
  const props = { m, pad }
  switch (tab) {
    case 'summary':
      return <SummarySection m={m} wide={wide} />
    case 'posting':
      return <PostingSection {...props} />
    case 'application':
      return <ApplicationSection {...props} />
    case 'emails':
      return <EmailsSection {...props} />
  }
}
