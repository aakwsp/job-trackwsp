import type { Application, Job, Stage } from '../../types'
import { daysLeft, daysSince, isClosingSoon, isExpired, localYmd } from '../../lib/jobs'
import { agoIso, recordTimeline, stageColor, stageTrack, type TimelineEntry } from '../../lib/applications'
import type { Tab } from '../../lib/record'
import {
  Band,
  Dated,
  Details,
  Empty,
  Row,
  outlineButton,
  primaryButton,
  ghostButton,
  appliedButton,
  Keyed,
  type Pad,
  type TagSpec,
} from './parts'

// Everything a section needs, computed once by Record. One object instead
// of a dozen props, since all four sections draw from the same record.
export type RecordModel = {
  job: Job | null
  app: Application | null
  tags: TagSpec[]
  next: Stage | null // where [ → next stage ] goes; null hides it
  canReject: boolean
  canUndo: boolean
  open: () => void
  toggleApplied: () => void // applies, or unapplies once applied
  advance: () => void
  reject: () => void
  undo: () => void
  // Switches the record to another tab (the summary's "→" links).
  goTo: (tab: Tab) => void
  notes: {
    id: string
    value: string
    error: string | null
    onChange: (v: string) => void
    onBlur: () => void
  }
}

type SectionProps = {
  m: RecordModel
  pad: Pad
}

// ── summary ──────────────────────────────────────────────────────────────

// An overview, not a copy of the other tabs: where things stand and what's
// next on the left; the latest of everything else on the right, each with
// a link to its full tab. `wide` (the expanded page) puts the two side by
// side; the drawer stacks them.
export function SummarySection({ m, wide }: { m: RecordModel; wide: boolean }) {
  const left = wide ? 'pr-8 pl-[3.1875rem]' : 'pr-8 pl-[2.1875rem]'
  const right = wide ? 'pr-12 pl-8' : 'pr-8 pl-[2.1875rem]'
  return (
    // `minmax(0, 1fr)` rather than `1fr`: lets a column shrink below its
    // content's natural width, so long text wraps instead of overflowing.
    <div className={`grid flex-1 ${wide ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-1'}`}>
      <div className="flex min-w-0 flex-col">
        <div className={`pt-[1.375rem] ${left}`}>
          <StageTrack app={m.app} />
          <p className="mt-[1.125rem] font-serif text-[1.375rem] leading-tight">{nextLine(m.job, m.app)}</p>
        </div>
        <AtAGlance m={m} pad={left} />
        <Notes m={m} pad={left} />
      </div>

      {/* In the drawer the right column follows the left one, so it needs
          its own gap above; side by side, a hairline between them instead. */}
      <div className={`flex min-w-0 flex-col pb-2 ${wide ? 'border-l border-rule' : 'mt-6'}`}>
        <Recent m={m} pad={right} noTop={wide} />
        <LatestEmail m={m} pad={right} />
        <PostingBrief m={m} pad={right} />
        <PrimaryAction m={m} pad={right} />
      </div>
    </div>
  )
}

/**
 * Where things stand, in plain words: "not applied · closes in 8 days",
 * "waiting on response · 3d in applied", "interview stage · 5d".
 */
function nextLine(job: Job | null, app: Application | null): string {
  if (!app) {
    const left = daysLeft(job?.deadline ?? null)
    const when =
      left === null
        ? 'rolling'
        : left > 1
          ? `closes in ${left} days`
          : left === 1
            ? 'closes tomorrow'
            : left === 0
              ? 'closes today'
              : `past due ${-left}d`
    return `not applied · ${when}`
  }
  const days = app.stage_since ? (daysSince(localYmd(app.stage_since)) ?? 0) : 0
  const d = days <= 0 ? 'today' : `${days}d`
  switch (app.status) {
    case 'applied':
      return `waiting on response · ${days <= 0 ? 'new' : d} in applied`
    case 'assessment':
    case 'interview':
      return `${app.status} stage · ${d}`
    case 'offer':
      return `offer in hand · ${d}`
    default:
      return `${app.status} · ${app.stage_since ? localYmd(app.stage_since) : ''}`
  }
}

// Four counters in a hairline grid, the same frame as the stage track.
function AtAGlance({ m, pad }: SectionProps) {
  const { job, app } = m
  const first = daysSince(job?.first_seen ?? null)
  const applied = app?.applied_at ? daysSince(localYmd(app.applied_at)) : null
  const inStage = app?.stage_since ? daysSince(localYmd(app.stage_since)) : null
  const left = daysLeft(job?.deadline ?? null)
  // Only before applying does the deadline matter; then it's tinted like
  // the posting's status: pink in the final days, grey once passed.
  const deadlineTone = !job || app ? '' : isExpired(job) ? 'text-text-dim' : isClosingSoon(job) ? 'text-pink' : ''
  const cells: { label: string; value: string; tone?: string }[] = [
    { label: 'since first seen', value: first === null ? '—' : `${first}d` },
    { label: 'since applied', value: applied === null ? '—' : `${applied}d` },
    { label: 'in stage', value: inStage === null ? '—' : `${inStage}d` },
    {
      label: 'deadline',
      value: !job ? '—' : left === null ? 'rolling' : left < 0 ? 'past due' : `${left}d left`,
      tone: deadlineTone,
    },
  ]
  return (
    <section className="mt-6">
      <Band pad={pad}>
        <h3 className="font-mono">// at a glance</h3>
      </Band>
      <div className={`pt-4 ${pad}`}>
        <dl className="m-0 grid grid-cols-2 border-t border-l border-rule-strong min-[760px]:grid-cols-4">
          {cells.map((c) => (
            // `flex-col-reverse`: the <dt> label comes first in the markup
            // (as a <dl> requires) but shows under the number.
            <div key={c.label} className="flex flex-col-reverse border-r border-b border-rule-strong px-3 py-2.5">
              <dt className="mt-1 text-[0.59375rem] tracking-[0.12em] text-text-muted uppercase">{c.label}</dt>
              <dd className={`m-0 text-sub ${c.tone ?? ''}`}>{c.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

function Notes({ m, pad }: SectionProps) {
  return (
    <section className="mt-6 flex flex-1 flex-col">
      <Band
        pad={pad}
        aside={m.notes.error ? <span className="text-pink">not saved: {m.notes.error}</span> : 'plain text · saved on blur'}
      >
        <label htmlFor={m.notes.id}>// notes</label>
      </Band>
      <div className={`flex flex-1 flex-col pt-4 ${pad}`}>
        <textarea
          id={m.notes.id}
          value={m.notes.value}
          onChange={(e) => m.notes.onChange(e.target.value)}
          onBlur={m.notes.onBlur}
          placeholder="write something to future you…"
          // `flex-1` + `min-h`: the box grows to fill whatever height is
          // left in the panel, but never shrinks below a usable size.
          className="min-h-[7.5rem] w-full flex-1 resize-y border border-rule-strong bg-bg px-3.5 py-3 text-meta leading-[1.7] text-text outline-none placeholder:text-text-dim focus-visible:border-text-muted"
        />
      </div>
    </section>
  )
}

// A "[ full timeline → ]"-style link to another tab.
function TabLink({ m, tab, children }: { m: RecordModel; tab: Tab; children: string }) {
  return (
    <button type="button" onClick={() => m.goTo(tab)} className={`${ghostButton} -ml-1 text-micro`}>
      {children}
    </button>
  )
}

function Recent({ m, pad, noTop }: SectionProps & { noTop: boolean }) {
  // The three latest entries, newest first. `slice(-3)` takes them from the
  // end of the oldest-first list; `reverse` on that copy is safe.
  const recent = recordTimeline(m.job, m.app).slice(-3).reverse()
  return (
    <section>
      <Band pad={pad} noTop={noTop} aside="newest first">
        <h3 className="font-mono">// recent</h3>
      </Band>
      <div className={`pt-4 ${pad}`}>
        {recent.length > 0 ? (
          <TimelineList entries={recent} />
        ) : (
          <p className="pb-2 text-meta text-text-dim">nothing yet.</p>
        )}
        <TabLink m={m} tab="application">
          [ full timeline → ]
        </TabLink>
      </div>
    </section>
  )
}

// Gmail parsing isn't built yet, so there's never an email to show. When
// it lands, the newest parsed email for this application goes here.
function LatestEmail({ m, pad }: SectionProps) {
  return (
    <section className="mt-4">
      <Band pad={pad}>
        <h3 className="font-mono">// latest email</h3>
      </Band>
      <div className={`pt-4 ${pad}`}>
        <p className="font-serif text-[1.125rem] text-text-dim">[ no emails yet ]</p>
        <TabLink m={m} tab="emails">
          [ all emails → ]
        </TabLink>
      </div>
    </section>
  )
}

// The posting's essentials only; the rest is on the posting tab.
function PostingBrief({ m, pad }: SectionProps) {
  const { job } = m
  return (
    <section className="mt-4">
      <Band pad={pad}>
        <h3 className="font-mono">// posting</h3>
      </Band>
      <div className={`pt-1.5 ${pad}`}>
        {job ? (
          <Details>
            <Row label="req id" first>
              {job.req_id ?? <span className="text-text-muted">— not listed</span>}
            </Row>
            <Row label="source">{job.source ?? <span className="text-text-muted">—</span>}</Row>
            <Row label="deadline">
              <Deadline job={job} />
            </Row>
            {job.borderline && (
              <Row label="borderline">
                <Borderline job={job} />
              </Row>
            )}
          </Details>
        ) : (
          <p className="pt-2.5 pb-1 text-meta text-text-dim">{noPostingText(m.app)}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <TabLink m={m} tab="posting">
            [ posting details → ]
          </TabLink>
          {job && <OpenButton m={m} />}
        </div>
      </div>
    </section>
  )
}

// The one thing to do next, if there is one.
function PrimaryAction({ m, pad }: SectionProps) {
  const action =
    !m.app && m.job ? (
      <button type="button" onClick={m.toggleApplied} className={primaryButton}>
        <Keyed label="mark applied" k="a" />
      </button>
    ) : m.next ? (
      <button type="button" onClick={m.advance} aria-label={`move to ${m.next}`} className={primaryButton}>
        <Keyed label="→ next stage" k="n" />
      </button>
    ) : null
  if (!action) return null
  return (
    <div className={`flex flex-wrap gap-2 pt-6 ${pad}`}>
      {action}
      {m.app && <AppliedButton m={m} />}
    </div>
  )
}

// What [ mark applied ] turns into once applied. Clicking it unapplies,
// which App only allows while the application has no progress.
function AppliedButton({ m }: { m: RecordModel }) {
  if (!m.job) return null
  return (
    <button type="button" onClick={m.toggleApplied} aria-label="applied — click to unapply" className={appliedButton}>
      <Keyed label="applied ✓" k="a" />
    </button>
  )
}

// Four cells, one per stage, each with the date it was reached. The current
// one is tinted in its colour (the same 10% `color-mix` as `.label`); done
// ones are muted, the rest dim. With no application the whole track is dim.
function StageTrack({ app }: { app: Application | null }) {
  return (
    <ol
      aria-label="stages"
      className="m-0 grid list-none grid-cols-2 border-t border-l border-rule-strong p-0 min-[760px]:grid-cols-4"
    >
      {stageTrack(app).map(({ stage, date, state }) => (
        <li
          key={stage.key}
          data-color={state === 'current' ? stage.color : undefined}
          aria-current={state === 'current' ? 'step' : undefined}
          className={`border-r border-b border-rule-strong px-3 py-2.5 ${
            state === 'current' ? 'bg-[color-mix(in_srgb,var(--c)_10%,transparent)]' : ''
          }`}
        >
          <div
            className={`flex items-center gap-[0.4375rem] text-[0.59375rem] tracking-[0.12em] uppercase ${
              state === 'current' ? 'text-(--c)' : state === 'done' ? 'text-text-muted' : 'text-text-dim'
            }`}
          >
            <span
              aria-hidden
              className={`flag mark-xs ${state === 'current' ? 'bg-(--c)' : state === 'done' ? 'bg-text-muted' : 'bg-rule-strong'}`}
            />
            {stage.key}
          </div>
          <div className={`mt-[0.4375rem] text-[0.6875rem] ${state === 'off' ? 'text-text-dim' : 'text-text'}`}>
            {date ?? '—'}
          </div>
        </li>
      ))}
    </ol>
  )
}

// ── shared bits ──────────────────────────────────────────────────────────

function Deadline({ job }: { job: Job }) {
  return job.deadline ? (
    // Same tint as the posting's status; none once applied.
    <span className={job.applied ? '' : isExpired(job) ? 'text-text-dim' : isClosingSoon(job) ? 'text-pink' : ''}>
      {job.deadline}
    </span>
  ) : (
    <span className="text-text-muted">rolling</span>
  )
}

function Borderline({ job }: { job: Job }) {
  return (
    <span className="inline-flex items-baseline gap-2 text-blue">
      <span aria-hidden className="flag mark-xs shrink-0 -translate-y-px bg-blue" />
      {job.borderline_reason ?? 'yes'}
    </span>
  )
}

function noPostingText(app: Application | null): string {
  return app?.job_id
    ? 'you dismissed this posting from the jobs list. the application is unaffected.'
    : 'added by hand — the scheduler never found this one.'
}

function OpenButton({ m }: { m: RecordModel }) {
  return (
    <button type="button" onClick={m.open} disabled={!m.job?.url} className={outlineButton}>
      <Keyed label="open posting ↗" k="o" />
    </button>
  )
}

// Date · mark · label · kind, with a 1px rail joining each mark to the next.
function TimelineList({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="m-0 list-none p-0 pb-1.5">
      {entries.map((t, i) => {
        const isApp = t.kind === 'application'
        return (
          // Index in the key: two entries can share a date and label
          // (say, interview → undo → interview again).
          <li
            key={`${i}-${t.date}-${t.label}`}
            className="grid min-h-[2.375rem] grid-cols-[5.75rem_1rem_minmax(0,1fr)_auto] gap-x-3 text-meta leading-normal"
          >
            <span className="text-text-muted">{t.date}</span>
            {/* The rail is absolutely placed so it can run past the row's
                padding and join the next mark. */}
            <span aria-hidden className="relative block">
              {i < entries.length - 1 && (
                <span className="absolute top-[0.9375rem] -bottom-1 left-[0.4375rem] w-px bg-rule-strong" />
              )}
              <span
                className={`absolute ${
                  // Sizes come from `.mark-sm` / `.mark-xs`, not a Tailwind
                  // `size-*`: see the note on them in index.css.
                  isApp ? 'marker mark-sm top-1.5 left-1' : 'flag mark-xs top-[0.4375rem] left-[0.3125rem]'
                } ${t.color ? '' : isApp ? 'bg-text-dim' : 'bg-text-muted'}`}
                data-color={t.color ?? undefined}
              />
            </span>
            <span className={isApp ? 'text-text' : 'text-text-muted'}>{t.label}</span>
            <span className="text-micro text-text-dim">{t.kind}</span>
          </li>
        )
      })}
    </ol>
  )
}

// ── posting · application · emails ───────────────────────────────────────

export function PostingSection({ m, pad }: SectionProps) {
  const { job } = m
  const band = (
    <Band pad={pad} noTop>
      <h3 className="font-mono">// details</h3>
    </Band>
  )
  if (!job) {
    return (
      <div>
        {band}
        <Empty title={m.app?.job_id ? '[ posting hidden ]' : '[ no posting ]'} pad={pad}>
          {noPostingText(m.app)}
        </Empty>
      </div>
    )
  }
  return (
    <div>
      {band}
      <div className={`pt-1.5 ${pad}`}>
        <Details>
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
          <Row label="deadline">
            <Deadline job={job} />
          </Row>
          {job.borderline && (
            <Row label="borderline">
              <Borderline job={job} />
            </Row>
          )}
        </Details>
      </div>
      <div className={`pt-[1.125rem] pb-1 ${pad}`}>
        <PostingActions m={m} />
      </div>
    </div>
  )
}

// Under the posting's details. Not applied: the same two buttons as the
// application tab. Applied: when, in green, and a way to the application.
// Closed: how it ended instead.
function PostingActions({ m }: { m: RecordModel }) {
  const { app } = m
  if (!app) {
    return (
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={m.toggleApplied} className={primaryButton}>
          <Keyed label="mark applied" k="a" />
        </button>
        <OpenButton m={m} />
      </div>
    )
  }
  const closed = stageColor(app.status) === null
  const line = closed
    ? `${app.status} ${app.stage_since ? localYmd(app.stage_since) : ''}`
    : `applied ${app.applied_at ? localYmd(app.applied_at) : ''} · ${agoIso(app.applied_at)}`
  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 text-meta">
        <span className={closed ? 'text-text-muted' : 'text-green'}>{line}</span>
        <TabLink m={m} tab="application">
          [ view application → ]
        </TabLink>
      </div>
      <div className="flex flex-wrap gap-2">
        <AppliedButton m={m} />
        <OpenButton m={m} />
      </div>
    </>
  )
}

export function ApplicationSection({ m, pad }: SectionProps) {
  const { app, job } = m
  if (!app) {
    return (
      <div>
        <Empty title="[ not applied yet ]" pad={pad}>
          no stage, no timeline. marking it applied starts the record from today.
        </Empty>
        <div className={`flex flex-wrap gap-2 pt-[1.375rem] ${pad}`}>
          {job && (
            <button type="button" onClick={m.toggleApplied} className={primaryButton}>
              <Keyed label="mark applied" k="a" />
            </button>
          )}
          <OpenButton m={m} />
        </div>
      </div>
    )
  }

  const color = stageColor(app.status)
  const closed = color === null
  return (
    <div>
      <Band pad={pad} noTop>
        <h3 className="font-mono">// application</h3>
      </Band>
      <div className={`pt-1.5 ${pad}`}>
        <Details>
          <Row label="current stage" first>
            <span
              className={`inline-flex items-center gap-2 ${closed ? 'text-text-muted' : 'text-(--c)'}`}
              data-color={color ?? undefined}
            >
              <span aria-hidden className={`marker mark-xs ${closed ? 'bg-text-muted' : ''}`} data-color={color ?? undefined} />
              {app.status}
            </span>
          </Row>
          <Row label="applied">
            <Dated ymd={app.applied_at && localYmd(app.applied_at)} ago={agoIso(app.applied_at)} />
          </Row>
          <Row label={closed ? 'closed' : 'in stage since'}>
            <Dated ymd={app.stage_since && localYmd(app.stage_since)} ago={agoIso(app.stage_since)} />
          </Row>
        </Details>
      </div>

      <section className="mt-6">
        <Band pad={pad} aside="oldest first">
          <h3 className="font-mono">// timeline</h3>
        </Band>
        <div className={`pt-[1.125rem] ${pad}`}>
          <TimelineList entries={recordTimeline(job, app)} />
        </div>
      </section>

      <section className="mt-[1.125rem]">
        <Band pad={pad}>
          <h3 className="font-mono">// actions</h3>
        </Band>
        <div className={`pt-4 pb-1 ${pad}`}>
          {(closed || app.status === 'offer') && (
            <p className="mb-2.5 flex items-center gap-2.5 text-meta">
              <span aria-hidden className={`marker mark-xs ${closed ? 'bg-text-dim' : ''}`} data-color={color ?? undefined} />
              <span className={closed ? 'text-text-muted' : 'text-green'}>
                {closed ? app.status : 'offer recorded'} {app.stage_since && localYmd(app.stage_since)}
              </span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {m.next && (
              <button type="button" onClick={m.advance} aria-label={`move to ${m.next}`} className={primaryButton}>
                <Keyed label="→ next stage" k="n" />
              </button>
            )}
            {m.canReject && (
              <button type="button" onClick={m.reject} className={outlineButton}>
                <Keyed label="mark rejected" k="r" />
              </button>
            )}
            {m.canUndo && (
              <button type="button" onClick={m.undo} className={`${ghostButton} h-11 text-micro`}>
                <Keyed label="undo" k="u" />
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

export function EmailsSection({ m, pad }: SectionProps) {
  const company = m.job?.company ?? m.app?.company ?? 'them'
  return (
    <Empty title="[ no emails yet ]" pad={pad}>
      parsed mail from {company.toLowerCase()} will land here, classified as it arrives.
    </Empty>
  )
}
