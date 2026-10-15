import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '../../api'
import type { IgnoredRow, InboxJob, InboxRow } from '../../types'
import { LOW_SCORE, eventColor, eventLabel, localDay, sortRows, type MailSort } from '../../lib/inbox'
import type { useInbox } from '../../lib/useInbox'
import InboxDetailPane from './InboxDetail'

// INBOX (JT-18), from design/inbox/Inbox.dc.html: the list on the left
// (2fr), the open email on the right (3fr). The detail column is sticky with
// its own scroll, so opening a row far down the list doesn't leave it
// off-screen.

type Props = {
  inbox: ReturnType<typeof useInbox>
  // Shown at the top of the list column (the disconnected state).
  top?: ReactNode
  // Gmail is connected: an empty // checking then says "nothing to check".
  connected: boolean
}

type Mode = 'email' | 'job'
type JobSort = 'activity' | 'company'

export default function Inbox({ inbox, top, connected }: Props) {
  // `g` toggles by email / by job.
  const [mode, setMode] = useState<Mode>('email')
  const [jobSort, setJobSort] = useState<JobSort>('activity')
  const [jobId, setJobId] = useState<number | null>(null)
  const [sort, setSort] = useState<MailSort>('newest')
  const [showIgnored, setShowIgnored] = useState(false)
  // Memoized: `?? []` alone would be a new array every render while
  // loading, re-running every memo and effect below.
  const rows = useMemo(() => inbox.rows ?? [], [inbox.rows])

  const checking = useMemo(() => sortRows(rows.filter((r) => r.status === 'checking'), sort), [rows, sort])
  const all = useMemo(() => sortRows(rows.filter((r) => r.status !== 'checking'), sort), [rows, sort])

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
    const nodes = await api.appEmails(id)
    const last = nodes[nodes.length - 1]
    if (last) open(last.email_id)
  }

  // Keys: `m` read/unread, `g` by email / by job, ←/→ along the open
  // email's timeline. A ref keeps the handler reading current values
  // without re-subscribing every render.
  const current = rows.find((r) => r.id === openId)
  // j/k walk this order: checking, then all mail (by email), or the
  // applications (by job).
  const order = useMemo(() => [...checking, ...all].map((r) => r.id), [checking, all])
  const jobOrder = useMemo(() => (inbox.jobs ?? []).map((j) => j.application_id), [inbox.jobs])
  const keyState = useRef({ current, timeline: inbox.detail?.timeline ?? [], openId, order, jobOrder, mode, jobId, openJob })
  useEffect(() => {
    keyState.current = { current, timeline: inbox.detail?.timeline ?? [], openId, order, jobOrder, mode, jobId, openJob }
  })
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return
      const { current: r, timeline, openId: id, order: ids, jobOrder: jobs, mode: md, jobId: job, openJob: goJob } = keyState.current
      if (e.key === 'j' || e.key === 'k') {
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
        setMode((m) => (m === 'email' ? 'job' : 'email'))
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && timeline.length > 0) {
        const i = timeline.findIndex((n) => n.email_id === id)
        const next = timeline[i + (e.key === 'ArrowRight' ? 1 : -1)]
        if (!next) return
        inbox.open(next.email_id)
      } else return
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [inbox])

  return (
    <div className="grid grid-cols-1 border-t border-rule-strong border-b border-b-rule min-[900px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section aria-label="mail" className="min-w-0 border-b border-rule min-[900px]:border-r min-[900px]:border-b-0">
        <Toolbar mode={mode} onMode={setMode} sort={sort} onSort={setSort} jobSort={jobSort} onJobSort={setJobSort} />
        {top}
        {mode === 'job' ? (
          <JobList jobs={inbox.jobs ?? []} sort={jobSort} currentId={jobId} onOpen={openJob} />
        ) : (
          <>
        {checking.length > 0 ? (
          <>
            <Band count={checking.length}>// checking</Band>
            <RowList rows={checking} openId={openId} onOpen={(id) => open(id)} />
          </>
        ) : (
          connected &&
          inbox.rows && (
            // The InboxEmpty board: the section stays, saying so.
            <>
              <Band count={0}>// checking</Band>
              <div className="border-b border-rule pt-[1.375rem] pr-5 pb-6 pl-6">
                <p className="font-serif text-[1.375rem] leading-[1.1] text-text-dim">nothing to check.</p>
                <p className="mt-2 text-[0.65625rem] text-text-dim">low-confidence mail lands here for a manual look.</p>
              </div>
            </>
          )
        )}
        <Band count={all.length} top={checking.length > 0 || connected || !!top}>
          // all mail
        </Band>
        <RowList rows={all} openId={openId} onOpen={(id) => open(id)} />
        <IgnoredLine
          ignored={inbox.ignored ?? []}
          open={showIgnored}
          onToggle={() => setShowIgnored((x) => !x)}
          onRestore={(r) => inbox.act(() => api.mailRestore(r.gmail_id))}
        />
          </>
        )}
      </section>

      {/* `self-start` + `sticky top-0`: the pane stays in view while the
          list scrolls; its own max height and scroll keep long emails in
          reach. 4.5rem = the strip + header above <main>. */}
      <section aria-label="detail" className="sticky top-0 flex max-h-[calc(100vh-4.5rem)] min-w-0 flex-col self-start overflow-y-auto">
        {inbox.error && <p className="border-b border-rule px-8 py-2 text-meta text-pink">{inbox.error}</p>}
        {inbox.detail ? (
          <InboxDetailPane detail={inbox.detail} act={inbox.act} large={mode === 'job'} onOpenEmail={(id) => open(id)} />
        ) : (
          <p className="px-8 py-10 text-meta text-text-dim">{inbox.rows ? 'no mail yet.' : 'loading…'}</p>
        )}
      </section>
    </div>
  )
}

// The toolbar row above the list: view mode, then that mode's sorts.
function Toolbar(props: {
  mode: Mode
  onMode: (m: Mode) => void
  sort: MailSort
  onSort: (s: MailSort) => void
  jobSort: JobSort
  onJobSort: (s: JobSort) => void
}) {
  const { mode, onMode } = props
  return (
    <div className="flex h-11 items-center gap-1 overflow-x-auto border-b border-rule pr-5 pl-[1.125rem] whitespace-nowrap">
      <Seg on={mode === 'email'} onClick={() => onMode('email')}>
        [ by email ]
      </Seg>
      <Seg on={mode === 'job'} onClick={() => onMode('job')}>
        [ by job ]
      </Seg>
      <span className="ml-auto pr-0.5 text-[0.65625rem] text-text-dim">sort</span>
      {mode === 'email'
        ? (['newest', 'company', 'score'] as MailSort[]).map((s) => (
            <Seg key={s} on={props.sort === s} dim onClick={() => props.onSort(s)}>
              {s}
            </Seg>
          ))
        : (
            [
              ['activity', 'latest activity'],
              ['company', 'company'],
            ] as [JobSort, string][]
          ).map(([s, label]) => (
            <Seg key={s} on={props.jobSort === s} dim onClick={() => props.onJobSort(s)}>
              {label}
            </Seg>
          ))}
    </div>
  )
}

// By job: company → its applications (role, stage, email count, unread),
// as on the InboxByJob board.
function JobList({
  jobs,
  sort,
  currentId,
  onOpen,
}: {
  jobs: InboxJob[]
  sort: JobSort
  currentId: number | null
  onOpen: (applicationId: number) => void
}) {
  const companies = new Map<string, InboxJob[]>()
  for (const j of jobs) companies.set(j.company.toLowerCase(), [...(companies.get(j.company.toLowerCase()) ?? []), j])
  const latest = (js: InboxJob[]) => js.map((j) => j.latest ?? '').sort().slice(-1)[0] ?? ''
  const groups = [...companies].sort(([a, x], [b, y]) => (sort === 'company' ? a.localeCompare(b) : latest(y).localeCompare(latest(x))))
  if (groups.length === 0) return <p className="px-6 py-6 text-meta text-text-dim">no emails matched to an application yet.</p>
  return (
    <>
      {groups.map(([co, js]) => (
        <div key={co} className="border-b border-rule">
          <div className="pt-3.5 pr-5 pb-1 pl-6 font-serif text-[1.25rem] leading-[1.05]">{co}</div>
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
                    className={`block w-full cursor-pointer py-2 pr-5 pl-6 text-left hover:bg-bg-active ${
                      current ? 'bg-bg-active outline outline-text -outline-offset-1' : ''
                    }`}
                  >
                    <span className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate text-meta">{j.title}</span>
                      <span data-color={color ?? undefined} className={`text-[0.6875rem] ${color ? 'text-(--c)' : 'text-text-muted'}`}>
                        {j.status}
                      </span>
                    </span>
                    <span className="mt-1 block text-[0.65625rem] text-text-dim">
                      {j.emails} {j.emails === 1 ? 'email' : 'emails'}
                      {j.unread > 0 && <span className="text-text"> · {j.unread} unread</span>}
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

// A segment button: the active one in text colour with a hairline under it.
// `dim`: inactive ones in --text-dim (the sort row) instead of muted.
export function Seg({ on, dim, onClick, children }: { on: boolean; dim?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`h-7 cursor-pointer border-b px-1.5 text-[0.65625rem] hover:text-text ${
        on ? `text-text ${dim ? 'border-text' : 'border-transparent'}` : `border-transparent ${dim ? 'text-text-dim' : 'text-text-muted'}`
      }`}
    >
      {children}
    </button>
  )
}

// A `// section` band, with a count on the right.
export function Band({ children, count, top = false }: { children: ReactNode; count?: number; top?: boolean }) {
  return (
    <div
      className={`flex h-9 items-center border-b border-rule bg-bg pr-5 pl-6 text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase ${
        top ? 'border-t' : ''
      }`}
    >
      <h2 className="font-mono">{children}</h2>
      {count !== undefined && <span className="ml-auto text-micro tracking-[0.02em] text-text-dim normal-case">{count}</span>}
    </div>
  )
}

function RowList({ rows, openId, onOpen }: { rows: InboxRow[]; openId: number | null; onOpen: (id: number) => void }) {
  return (
    <ul className="m-0 list-none p-0">
      {rows.map((r) => (
        <li key={r.id} className="border-b border-rule">
          <Row row={r} current={r.id === openId} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  )
}

// One email: unread dot, company, event type in its stage colour, the
// routing score (pink when low), "auto"; then subject and date.
function Row({ row, current, onOpen }: { row: InboxRow; current: boolean; onOpen: (id: number) => void }) {
  const color = eventColor(row.event_type)
  const unread = !row.read
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      aria-current={current || undefined}
      data-inbox-row={row.id}
      className={`block w-full cursor-pointer pt-[0.8125rem] pr-5 pb-3 pl-6 text-left hover:bg-bg-active ${
        current ? 'bg-bg-active outline outline-text -outline-offset-1' : ''
      }`}
    >
      <span className="flex items-center gap-2.5">
        <span
          role="img"
          aria-label={unread ? 'unread' : 'read'}
          className={`size-[0.3125rem] shrink-0 ${unread ? 'bg-text' : 'bg-transparent'}`}
        />
        <span className={`font-serif text-[1.1875rem] leading-[1.05] lowercase ${unread ? 'text-text' : 'text-text-muted'}`}>
          {row.company ?? '—'}
        </span>
        <span data-color={color ?? undefined} className={`text-[0.6875rem] ${color ? 'text-(--c)' : 'text-text-muted'}`}>
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
        <span className={`min-w-0 flex-1 truncate ${unread ? 'text-text' : 'text-text-muted'}`}>{row.subject ?? ''}</span>
        <span className="shrink-0 text-text-dim">{localDay(row.received_at)}</span>
      </span>
    </button>
  )
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
