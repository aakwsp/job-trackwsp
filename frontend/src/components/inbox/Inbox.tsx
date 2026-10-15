import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useStuck } from '../../lib/useStuck'
import { loadFolded, loadListCollapsed, saveFolded, saveListCollapsed, type FoldKey } from '../../lib/inboxFold'
import * as api from '../../api'
import type { IgnoredRow, InboxJob, InboxRow } from '../../types'
import { LOW_SCORE, eventColor, eventLabel, loadSort, localDay, saveSort, sortRows, type MailSort } from '../../lib/inbox'
import type { useInbox } from '../../lib/useInbox'
import InboxDetailPane from './InboxDetail'
import InboxBar from './InboxBar'
import { useReveal } from '../../lib/reveal'
import { inboxFilterCounts, loadInboxFilters, matchesInboxFilters, saveInboxFilters, type InboxFilters } from '../../lib/inboxFilters'

// INBOX (JT-18), from design/inbox/Inbox.dc.html: the list on the left
// (about a quarter of the window, or a narrow strip when collapsed with
// `[`), the open email on the right. The detail column is sticky with
// its own scroll, so opening a row far down the list doesn't leave it
// off-screen.

type Props = {
  inbox: ReturnType<typeof useInbox>
  // Shown at the top of the list column (the disconnected state).
  top?: ReactNode
  // Gmail is connected: an empty // checking then says "nothing to check".
  connected: boolean
}


export default function Inbox({ inbox, top, connected }: Props) {
  // Sort is the view: newest = by email in sections, company = by job.
  // `g` flips it. Remembered like the JOBS view mode.
  const [sort, setSortState] = useState<MailSort>(loadSort)
  function setSort(s: MailSort) {
    setSortState(s)
    saveSort(s)
  }
  const mode = sort === 'company' ? 'job' : 'email'
  // The search line is always there: `/` jumps into it, esc clears it and
  // leaves it.
  const searchRef = useRef<HTMLInputElement>(null)
  // The list pane folded to a strip (`[` or the toolbar toggle); kept
  // across launches like the folded sections.
  const [narrow, setNarrow] = useState(loadListCollapsed)
  function toggleNarrow() {
    setNarrow((n) => {
      saveListCollapsed(!n)
      return !n
    })
  }
  const [jobId, setJobId] = useState<number | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  // [ filters ] (include / exclude per section and unread), kept like
  // the JOBS filters.
  const [filters, setFilters] = useState(loadInboxFilters)
  function changeFilters(f: InboxFilters) {
    setFilters(f)
    saveInboxFilters(f)
  }
  // Memoized: `?? []` alone would be a new array every render while
  // loading, re-running every memo and effect below.
  const allRows = useMemo(() => inbox.rows ?? [], [inbox.rows])
  const filterCounts = useMemo(() => inboxFilterCounts(allRows), [allRows])
  const rows = useMemo(() => allRows.filter((r) => matchesInboxFilters(r, filters)), [allRows, filters])
  // The toolbar band sticks to the top; its height goes into --toolbar-h
  // (as App does for JOBS) so the section bands, company headers and the
  // detail pane stick right under it. ResizeObserver: it changes when
  // chips wrap or the UI scale changes.
  const barRef = useRef<HTMLDivElement>(null)
  const [barH, setBarH] = useState(0)
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBarH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Sections by state: // checking (needs you; also mail still waiting
  // for Gemini or routing), // auto (applied automatically, untouched),
  // // checked (you confirmed or rejected it). The sort applies inside each.
  const checking = useMemo(
    () => sortRows(rows.filter((r) => r.status === 'checking' || r.status === 'pending' || r.status === 'extracted')),
    [rows],
  )
  const autoRows = useMemo(() => sortRows(rows.filter((r) => r.status === 'auto')), [rows])
  const checked = useMemo(() => sortRows(rows.filter((r) => r.status === 'confirmed' || r.status === 'rejected')), [rows])
  const all = useMemo(() => [...autoRows, ...checked], [autoRows, checked])

  // Something is always open, like the board: the first checking email,
  // else the newest. Not marked read: only an explicit open does that.
  const { openId, open } = inbox
  useEffect(() => {
    if (openId !== null && rows.some((r) => r.id === openId)) return
    const first = checking[0] ?? all[0]
    if (first) open(first.id, false)
  }, [rows, openId, checking, all, open])

  // Opening a job opens its newest email (the board's default).
  async function openJob(id: number) {
    setJobId(id)
    const emails = (await api.appTimeline(id)).filter((n) => n.kind === 'email')
    const last = emails.at(-1)
    if (last && last.email_id !== null) open(last.email_id)
  }

  // Keys: `m` read/unread, `g` by email / by job, ←/→ along the open
  // email's timeline. A ref keeps the handler reading current values
  // without re-subscribing every render.
  const current = rows.find((r) => r.id === openId)
  // j/k walk this order: checking, then all mail (by email), or the
  // applications (by job).
  // Folded sections, remembered across launches (lib/inboxFold.ts).
  const [folded, setFolded] = useState(loadFolded)
  function toggleFold(s: FoldKey) {
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      saveFolded(next)
      return next
    })
  }
  function foldAll(fold: boolean) {
    const next = new Set<FoldKey>(fold ? ['checking', 'auto', 'checked'] : [])
    saveFolded(next)
    setFolded(next)
  }
  // j/k walk the open sections only.
  const order = useMemo(
    () =>
      [
        ...(folded.has('checking') ? [] : checking),
        ...(folded.has('auto') ? [] : autoRows),
        ...(folded.has('checked') ? [] : checked),
      ].map((r) => r.id),
    [checking, autoRows, checked, folded],
  )

  // After confirm / reject: the email leaves // checking now (patched
  // ahead of the reload), and the next checking email opens.
  function resolved(id: number, status: InboxRow['status']) {
    const ids = checking.map((r) => r.id)
    const i = ids.indexOf(id)
    const next = ids[i + 1] ?? ids[i - 1]
    inbox.patchRow(id, { status })
    if (next !== undefined) open(next, false)
  }
  const jobOrder = useMemo(() => (inbox.jobs ?? []).map((j) => j.application_id), [inbox.jobs])
  const keyState = useRef({ current, timeline: (inbox.detail?.timeline ?? []).filter((n) => n.kind === 'email'), openId, order, jobOrder, mode, jobId, openJob })
  useEffect(() => {
    keyState.current = { current, timeline: (inbox.detail?.timeline ?? []).filter((n) => n.kind === 'email'), openId, order, jobOrder, mode, jobId, openJob }
  })
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return
      const { current: r, timeline, openId: id, order: ids, jobOrder: jobs, mode: md, jobId: job, openJob: goJob } = keyState.current
      if (e.key === '/') {
        searchRef.current?.focus()
      } else if (e.key === '[') {
        toggleNarrow()
      } else if (e.key === 'j' || e.key === 'k') {
        const step = e.key === 'j' ? 1 : -1
        if (md === 'job') {
          const next = jobs[jobs.indexOf(job ?? -1) + step] ?? (job === null ? jobs[0] : undefined)
          if (next === undefined) return
          goJob(next)
        } else {
          const next = ids[ids.indexOf(id ?? -1) + step] ?? (id === null ? ids[0] : undefined)
          if (next === undefined) return
          inbox.open(next)
          // Keep the newly open row in view as j/k walk the list.
          document.querySelector(`[data-inbox-row="${next}"]`)?.scrollIntoView({ block: 'nearest' })
        }
      } else if (e.key === 'm' && r) {
        inbox.act(() => api.inboxSetRead(r.id, !r.read))
      } else if (e.key === 'g') {
        setSort(md === 'email' ? 'company' : 'newest')
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && timeline.length > 0) {
        const i = timeline.findIndex((n) => n.email_id === id)
        const next = timeline[i + (e.key === 'ArrowRight' ? 1 : -1)]
        if (!next) return
        if (next.email_id !== null) inbox.open(next.email_id)
      } else return
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [inbox])

  return (
    // --toolbar-h is set here, for everything inside (it overrides App's,
    // which measures the JOBS toolbar).
    <div style={{ '--toolbar-h': `${barH}px` } as CSSProperties}>
      {/* The toolbar band, as on JOBS: full width under the hero, sticky,
          rising in after the title and subtitle (`--d`). `z-20` keeps the
          filter panel above the section bands (`z-10`). */}
      <div ref={barRef} className="enter sticky top-0 z-20 border-t border-rule-strong bg-bg" style={{ '--d': '160ms' } as CSSProperties}>
        <InboxBar
          searchRef={searchRef}
          query={inbox.query}
          onQuery={inbox.setQuery}
          filters={filters}
          onFilters={changeFilters}
          counts={filterCounts}
          sort={sort}
          onSort={setSort}
          narrow={narrow}
          onNarrow={toggleNarrow}
          onCollapseAll={() => foldAll(true)}
          onExpandAll={() => foldAll(false)}
        />
      </div>
      {top}
    {/* Both grid templates are complete literal class names: Tailwind only
        generates CSS for class names it finds written out in the source. */}
    <div
      data-narrow={narrow || undefined}
      className={`grid grid-cols-1 border-b border-rule ${
        narrow ? 'min-[900px]:grid-cols-[12rem_minmax(0,1fr)]' : 'min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]'
      }`}
    >
      <section aria-label="mail" className="min-w-0 border-b border-rule min-[900px]:border-r min-[900px]:border-b-0">
        {mode === 'job' ? (
          <JobList jobs={inbox.jobs ?? []} currentId={jobId} onOpen={openJob} query={inbox.searched} narrow={narrow} stickAt={barH} />
        ) : (
          <>
        {checking.length > 0 ? (
          <Section name="checking" count={checking.length} folded={folded.has('checking')} onToggle={toggleFold}>
            <RowList rows={checking} openId={openId} onOpen={(id) => open(id)} query={inbox.searched} narrow={narrow} />
          </Section>
        ) : (
          connected &&
          inbox.rows &&
          !inbox.searched && (
            // The InboxEmpty board: the section stays, saying so.
            <>
              <Section name="checking" count={0} folded={false} onToggle={() => {}} />
              <div className="border-b border-rule pt-[1.375rem] pr-5 pb-6 pl-6">
                <p className="font-serif text-[1.375rem] leading-[1.1] text-text-dim">nothing to check.</p>
                <p className="mt-2 text-[0.65625rem] text-text-dim">low-confidence mail lands here for a manual look.</p>
              </div>
            </>
          )
        )}
        {autoRows.length > 0 && (
          <Section
            name="auto"
            count={autoRows.length}
            folded={folded.has('auto')}
            onToggle={toggleFold}
          >
            <RowList rows={autoRows} openId={openId} onOpen={(id) => open(id)} query={inbox.searched} narrow={narrow} />
          </Section>
        )}
        {checked.length > 0 && (
          <Section
            name="checked"
            count={checked.length}
            folded={folded.has('checked')}
            onToggle={toggleFold}
          >
            <RowList rows={checked} openId={openId} onOpen={(id) => open(id)} query={inbox.searched} narrow={narrow} />
          </Section>
        )}
        {inbox.searched && rows.length === 0 && (
          <p className="py-6 pr-5 pl-6 text-meta text-text-dim">nothing matches “{inbox.searched}”.</p>
        )}
        {/* Ignored mail is never searched, so its line steps aside. */}
        {!inbox.searched && !narrow && <IgnoredLine
          ignored={inbox.ignored ?? []}
          open={showIgnored}
          onToggle={() => setShowIgnored((x) => !x)}
          onRestore={(r) => inbox.act(() => api.mailRestore(r.gmail_id))}
        />}
          </>
        )}
      </section>

      {/* `self-start` + `sticky`: the pane stays in view, under the
          toolbar band, while the list scrolls; its own max height and
          scroll keep long emails in reach. 4.5rem = the strip + header
          above <main>. */}
      <section
        aria-label="detail"
        className="sticky top-(--toolbar-h) flex max-h-[calc(100vh-4.5rem-var(--toolbar-h))] min-w-0 flex-col self-start overflow-y-auto"
      >
        {inbox.error && <p className="border-b border-rule px-8 py-2 text-meta text-pink">{inbox.error}</p>}
        {inbox.detail ? (
          <InboxDetailPane
            detail={inbox.detail}
            act={inbox.act}
            notify={inbox.notify}
            onResolved={resolved}
            large={mode === 'job'}
            onOpenEmail={(id) => open(id)}
          />
        ) : (
          <p className="px-8 py-10 text-meta text-text-dim">{inbox.rows ? 'no mail yet.' : 'loading…'}</p>
        )}
      </section>
    </div>
    </div>
  )
}

// By job: company → its applications (role, stage, email count, unread),
// as on the InboxByJob board.
function JobList({
  jobs,
  currentId,
  onOpen,
  query,
  narrow,
  stickAt,
}: {
  jobs: InboxJob[]
  currentId: number | null
  onOpen: (applicationId: number) => void
  query: string
  narrow: boolean
  // The toolbar band's height: company headers stick under it.
  stickAt: number
}) {
  const companies = new Map<string, InboxJob[]>()
  for (const j of jobs) companies.set(j.company.toLowerCase(), [...(companies.get(j.company.toLowerCase()) ?? []), j])
  // Companies A–Z; jobs inside a company keep their order (latest
  // activity first, as Rust returns them).
  const groups = [...companies].sort(([a], [b]) => a.localeCompare(b))
  if (groups.length === 0)
    return (
      <p className="px-6 py-6 text-meta text-text-dim">
        {query ? `nothing matches “${query}”.` : 'no emails matched to an application yet.'}
      </p>
    )
  return (
    <>
      {groups.map(([co, js]) => (
        // Each group is the sticky header's containing block, so the next
        // company's header pushes this one up instead of overlapping it.
        <div key={co} className="border-b border-rule">
          <CompanyHeader stickAt={stickAt}>{narrow ? cut(co) : <Hl text={co} query={query} />}</CompanyHeader>
          <ul className="m-0 list-none p-0 pb-2">
            {js.map((j) => {
              const color = eventColor(j.status === 'rejected' ? 'rejection' : j.status)
              const current = j.application_id === currentId
              return (
                <li key={j.application_id}>
                  <button
                    type="button"
                    onClick={() => onOpen(j.application_id)}
                    aria-current={current || undefined}
                    className={`block w-full cursor-pointer appearance-none py-2 pr-5 pl-6 text-left text-text ${
                      current ? 'bg-bg-active outline outline-text -outline-offset-1' : 'bg-transparent hover:bg-bg-active'
                    }`}
                  >
                    <span className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate text-meta">
                        <Hl text={j.title} query={query} />
                      </span>
                      <span data-color={color ?? undefined} className={`text-[0.6875rem] ${color ? 'text-(--c)' : 'text-text-muted'}`}>
                        {j.status}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-[0.65625rem] text-text-dim">
                      {j.emails} {narrow ? '' : j.emails === 1 ? 'email' : 'emails'}
                      {j.unread > 0 && <span className="text-text"> · {j.unread}{narrow ? '' : ' unread'}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </>
  )
}

// A state section (// checking, // auto, // checked): the JOBS city group
// band (CityGroup), same `.band` class, fold marker, count on the right,
// sticky under the toolbar band and rising in like the city bands. The
// band is a <button> (keyboard focus and Enter/Space for free); the rows
// stay mounted while folded so `.reveal` (index.css) can animate the
// height, and `inert` takes hidden rows out of Tab order.
function Section({
  name,
  count,
  folded,
  onToggle,
  children,
}: {
  name: FoldKey
  count: number
  folded: boolean
  onToggle: (s: FoldKey) => void
  children?: ReactNode
}) {
  const { ref, className: revealClass } = useReveal(`inbox-band:${name}`)
  return (
    <section>
      <button
        type="button"
        onClick={() => onToggle(name)}
        aria-expanded={!folded}
        ref={ref}
        className={`band rise ${revealClass} sticky top-(--toolbar-h) z-10 flex w-full cursor-pointer items-center justify-between hover:text-text`}
      >
        <span>
          {folded ? '+ ' : '- '}// {name}
        </span>
        <span className="text-text-dim">{count}</span>
      </button>
      <div className="reveal" data-open={!folded} inert={folded}>
        <div className="reveal-inner">{children}</div>
      </div>
    </section>
  )
}

// A company header in the by-job list: sticky (same surface as the list),
// with a hairline only while it's stuck.
function CompanyHeader({ children, stickAt }: { children: ReactNode; stickAt: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useStuck(ref, stickAt)
  return (
    <div
      ref={ref}
      // 1px above the band's bottom edge, so useStuck can tell it's stuck.
      className={`sticky top-[calc(var(--toolbar-h)-1px)] z-10 border-b bg-bg pt-3.5 pr-5 pb-1 pl-6 font-serif text-[1.25rem] leading-[1.05] ${
        stuck ? 'border-rule' : 'border-transparent'
      }`}
    >
      {children}
    </div>
  )
}

/** The text with every case-insensitive match of `query` marked. */
export function Hl({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let i = 0
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, i)) {
    parts.push(text.slice(i, at))
    // A dark mark: the rule-strong surface + underline, readable on the
    // row and on the selected row alike.
    parts.push(
      <mark key={at} className="bg-rule-strong text-text underline decoration-text-muted underline-offset-2">
        {text.slice(at, at + q.length)}
      </mark>,
    )
    i = at + q.length
  }
  parts.push(text.slice(i))
  return <>{parts}</>
}

function RowList({
  rows,
  openId,
  onOpen,
  query,
  narrow,
}: {
  rows: InboxRow[]
  openId: number | null
  onOpen: (id: number) => void
  query: string
  narrow: boolean
}) {
  return (
    <ul className="m-0 list-none p-0">
      {rows.map((r) => (
        <li key={r.id} className="border-b border-rule">
          {narrow ? (
            <NarrowRow row={r} current={r.id === openId} onOpen={onOpen} />
          ) : (
            <Row row={r} current={r.id === openId} onOpen={onOpen} query={query} />
          )}
        </li>
      ))}
    </ul>
  )
}

// One email: unread dot, company, event type in its stage colour, the
// routing score (pink when low), "auto"; then subject and date.
// Every state is explicit: resting = transparent, hovered or selected =
// the dark --bg-active surface (selected adds the parchment hairline), and
// `appearance: none` so WebKitGTK never draws a native (light) button
// under the text.
function Row({ row, current, onOpen, query }: { row: InboxRow; current: boolean; onOpen: (id: number) => void; query: string }) {
  const color = eventColor(row.event_type)
  const unread = !row.read
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      aria-current={current || undefined}
      data-inbox-row={row.id}
      className={`block w-full cursor-pointer appearance-none pt-[0.8125rem] pr-5 pb-3 pl-6 text-left text-text ${
        current ? 'bg-bg-active outline outline-text -outline-offset-1' : 'bg-transparent hover:bg-bg-active'
      }`}
    >
      <span className="flex items-center gap-2.5">
        <span
          role="img"
          aria-label={unread ? 'unread' : 'read'}
          className={`size-[0.3125rem] shrink-0 ${unread ? 'bg-text' : 'bg-transparent'}`}
        />
        {/* min-w-0 + truncate: a long company ends in … instead of
            pushing the score off the row (flex items won't shrink below
            their content without min-w-0). */}
        <span className={`min-w-0 truncate font-serif text-[1.1875rem] leading-[1.05] lowercase ${unread ? 'text-text' : 'text-text-muted'}`}>
          <Hl text={row.company ?? '—'} query={query} />
        </span>
        <span data-color={color ?? undefined} className={`shrink-0 text-[0.6875rem] ${color ? 'text-(--c)' : 'text-text-muted'}`}>
          {eventLabel(row.event_type)}
        </span>
        {row.score !== null && (
          <span className={`ml-auto text-[0.65625rem] ${row.score < LOW_SCORE ? 'text-pink' : 'text-text-muted'}`}>
            {row.score.toFixed(2)}
          </span>
        )}
        {row.status === 'auto' && <span className={`text-micro text-text-dim ${row.score === null ? 'ml-auto' : ''}`}>auto</span>}
      </span>
      <span className="mt-[0.4375rem] flex gap-3 pl-[0.9375rem] text-[0.6875rem]">
        <span className={`min-w-0 flex-1 truncate ${unread ? 'text-text' : 'text-text-muted'}`}>
          <Hl text={row.subject ?? ''} query={query} />
        </span>
        <span className="shrink-0 text-text-dim">{localDay(row.received_at)}</span>
      </span>
    </button>
  )
}

// A row of the collapsed list: the company cut to ten characters (bright
// = unread, muted = read), then the stage colour (a diamond, as on the timeline) where
// the subject was. Same paddings and line boxes as `Row`, so folding the
// list never moves a row.
function NarrowRow({ row, current, onOpen }: { row: InboxRow; current: boolean; onOpen: (id: number) => void }) {
  const color = eventColor(row.event_type)
  const unread = !row.read
  const dim = row.event_type === 'rejection'
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      aria-current={current || undefined}
      aria-label={`${row.company ?? '—'}, ${eventLabel(row.event_type)}${unread ? ', unread' : ''}`}
      title={row.company ?? undefined}
      data-inbox-row={row.id}
      className={`block w-full cursor-pointer appearance-none pt-[0.8125rem] pr-3 pb-3 pl-3 text-left text-text ${
        current ? 'bg-bg-active outline outline-text -outline-offset-1' : 'bg-transparent hover:bg-bg-active'
      }`}
    >
      {/* No unread dot here: bright vs muted name already says it. */}
      <span className="flex items-center">
        <span className={`font-serif text-[1.1875rem] leading-[1.05] whitespace-nowrap lowercase ${unread ? 'text-text' : 'text-text-muted'}`}>
          {cut(row.company ?? '—')}
        </span>
      </span>
      {/* Same text size as Row's subject line, so the line box (and the
          row) is the same height; the diamond sits in it. */}
      <span aria-hidden className="mt-[0.4375rem] flex items-center text-[0.6875rem]">
        <span
          data-color={color ?? undefined}
          className={`block size-1.5 rotate-45 ${color ? 'bg-(--c)' : dim ? 'bg-text-dim' : 'bg-text-muted'}`}
        />
        &#8203;
      </span>
    </button>
  )
}

/** A company name cut to ten characters, with … when it was longer. */
function cut(s: string): string {
  return s.length > 10 ? `${s.slice(0, 10)}…` : s
}

// The one quiet line under all mail: "n ignored". It opens the ignored
// list (sender, subject, date only) with [ not ignored ] per email.
function IgnoredLine({
  ignored,
  open,
  onToggle,
  onRestore,
}: {
  ignored: IgnoredRow[]
  open: boolean
  onToggle: () => void
  onRestore: (r: IgnoredRow) => void
}) {
  if (ignored.length === 0) return null
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="block w-full cursor-pointer py-3 pr-5 pl-6 text-left text-[0.65625rem] text-text-dim hover:text-text-muted"
      >
        {ignored.length} ignored
      </button>
      {open && (
        <ul className="m-0 list-none border-t border-rule p-0">
          {ignored.map((r) => (
            <li key={r.id} className="flex items-baseline gap-3 border-b border-rule py-2.5 pr-5 pl-6 text-[0.6875rem] text-text-muted">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{r.from_addr ?? ''}</span>
                <span className="block truncate text-text-dim">{r.subject ?? ''}</span>
              </span>
              <span className="shrink-0 text-text-dim">{localDay(r.received_at)}</span>
              <button type="button" onClick={() => onRestore(r)} className="shrink-0 cursor-pointer hover:text-text">
                [ not ignored ]
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
