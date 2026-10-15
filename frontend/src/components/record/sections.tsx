import type { Application, Job, Stage } from '../../types'
import { isClosingSoon, localYmd } from '../../lib/jobs'
import { agoIso, recordTimeline, stageColor, stageTrack } from '../../lib/applications'
import {
  Band,
  Dated,
  Details,
  Empty,
  Row,
  Tags,
  outlineButton,
  primaryButton,
  ghostButton,
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
  markApplied: () => void
  advance: () => void
  reject: () => void
  undo: () => void
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
  // In the expanded page every section is visible at once, so each gets a
  // `// name` band on top; in the drawer the tab already says which it is.
  expanded: boolean
}

export function SummarySection({ m, pad, expanded }: SectionProps) {
  const { job, app } = m
  return (
    <div className="flex flex-1 flex-col">
      {expanded && (
        <Band pad={pad} noTop>
          <h3 className="font-mono">// summary</h3>
        </Band>
      )}
      <div className={`pt-[1.375rem] ${pad}`}>
        <StageTrack app={app} />
        {!app && (
          <>
            <p className="mt-[1.125rem] font-serif text-[1.375rem] text-text-dim">[ not applied yet ]</p>
            <p className="mt-2 text-[0.65625rem] text-text-dim">the track starts when this posting is marked applied.</p>
          </>
        )}
      </div>

      <section className="mt-6">
        <Band pad={pad}>
          <h3 className="font-mono">// key dates</h3>
        </Band>
        <div className={`pt-1.5 ${pad}`}>
          <Details>
            <Row label="first seen" first>
              <Dated ymd={job?.first_seen ?? null} />
            </Row>
            <Row label="deadline">{job?.deadline ?? <span className="text-text-muted">rolling</span>}</Row>
            <Row label="applied">
              {app?.applied_at ? localYmd(app.applied_at) : <span className="text-text-dim">—</span>}
            </Row>
            <Row label="status">
              <Tags tags={m.tags} />
            </Row>
          </Details>
        </div>
      </section>

      <section className="mt-6 flex flex-1 flex-col">
        <Band
          pad={pad}
          aside={
            m.notes.error ? <span className="text-pink">not saved: {m.notes.error}</span> : 'plain text · saved on blur'
          }
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
    </div>
  )
}

// Four cells, one per stage. The current one is tinted in its colour (the
// same 10% `color-mix` as `.label`); done ones are muted, the rest dim.
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

export function PostingSection({ m, pad, expanded }: SectionProps) {
  const { job, app } = m
  const band = (
    <Band pad={pad} noTop>
      <h3 className="font-mono">{expanded ? '// posting' : '// details'}</h3>
    </Band>
  )
  if (!job) {
    return (
      <div>
        {band}
        {app?.job_id ? (
          <Empty title="[ posting hidden ]" pad={pad}>
            you dismissed this posting from the jobs list. the application is unaffected.
          </Empty>
        ) : (
          <Empty title="[ no posting ]" pad={pad}>
            added by hand — the scheduler never found this one.
          </Empty>
        )}
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
            {job.deadline ? (
              <span className={isClosingSoon(job) ? 'text-pink' : ''}>{job.deadline}</span>
            ) : (
              <span className="text-text-muted">rolling</span>
            )}
          </Row>
          {job.borderline && (
            <Row label="borderline">
              <span className="inline-flex items-baseline gap-2 text-blue">
                <span aria-hidden className="flag mark-xs shrink-0 -translate-y-px bg-blue" />
                {job.borderline_reason ?? 'yes'}
              </span>
            </Row>
          )}
        </Details>
      </div>
      <div className={`pt-[1.125rem] pb-1 ${pad}`}>
        <OpenButton m={m} />
      </div>
    </div>
  )
}

function OpenButton({ m }: { m: RecordModel }) {
  return (
    <button type="button" onClick={m.open} disabled={!m.job?.url} className={outlineButton}>
      [ open posting ↗ ]
    </button>
  )
}

export function ApplicationSection({ m, pad, expanded }: SectionProps) {
  const { app, job } = m
  if (!app) {
    return (
      <div>
        {expanded && (
          <Band pad={pad} noTop>
            <h3 className="font-mono">// application</h3>
          </Band>
        )}
        <Empty title="[ not applied yet ]" pad={pad}>
          no stage, no timeline. marking it applied starts the record from today.
        </Empty>
        <div className={`flex flex-wrap gap-2 pt-[1.375rem] ${pad}`}>
          {job && (
            <button type="button" onClick={m.markApplied} className={primaryButton}>
              [ mark applied ]
            </button>
          )}
          <OpenButton m={m} />
        </div>
      </div>
    )
  }

  const color = stageColor(app.status)
  const closed = color === null
  const timeline = recordTimeline(job, app)
  return (
    <div>
      <Band pad={pad} noTop>
        <h3 className="font-mono">// application</h3>
      </Band>
      <div className={`pt-1.5 ${pad}`}>
        <Details>
          <Row label="current stage" first>
            <span className={`inline-flex items-center gap-2 ${closed ? 'text-text-muted' : 'text-(--c)'}`} data-color={color ?? undefined}>
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
        <ol className={`m-0 list-none pt-[1.125rem] pb-1.5 ${pad}`}>
          {timeline.map((t, i) => {
            const isApp = t.kind === 'application'
            return (
              // Index in the key: two entries can share a date and label
              // (say, interview → undo → interview again).
              <li
                key={`${i}-${t.date}-${t.label}`}
                className="grid min-h-[2.375rem] grid-cols-[5.75rem_1rem_minmax(0,1fr)_auto] gap-x-3 text-meta leading-normal"
              >
                <span className="text-text-muted">{t.date}</span>
                {/* The mark, plus a 1px rail down to the next entry. The
                    rail is absolutely placed so it can run past the row's
                    padding and join the next mark. */}
                <span aria-hidden className="relative block">
                  {i < timeline.length - 1 && (
                    <span className="absolute top-[0.9375rem] -bottom-1 left-[0.4375rem] w-px bg-rule-strong" />
                  )}
                  <span
                    className={`absolute ${
                      // Sizes come from `.mark-sm` / `.mark-xs`, not a
                      // Tailwind `size-*`: see the note on them in index.css.
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
                [ → next stage ]
              </button>
            )}
            {m.canReject && (
              <button type="button" onClick={m.reject} className={outlineButton}>
                [ mark rejected ]
              </button>
            )}
            {m.canUndo && (
              <button type="button" onClick={m.undo} className={`${ghostButton} h-11 text-micro`}>
                [ undo ]
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

export function EmailsSection({ m, pad, expanded }: SectionProps) {
  const company = m.job?.company ?? m.app?.company ?? 'them'
  return (
    <div>
      {expanded && (
        <Band pad={pad} noTop>
          <h3 className="font-mono">// emails</h3>
        </Band>
      )}
      <Empty title="[ no emails yet ]" pad={pad}>
        parsed mail from {company.toLowerCase()} will land here, classified as it arrives.
      </Empty>
    </div>
  )
}
