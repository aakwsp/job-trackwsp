import type { AppStatus, Application, Job, Stage, StatusColor } from '../types'
import { daysSince, localYmd, postingEvents } from './jobs'

// The four pipeline columns, in order. The colours are the stage's own and
// mean something different from the JOBS list (where green = applied):
// here green is the finish line, an offer.
export type StageInfo = {
  key: Stage
  color: StatusColor
  empty: string // column empty state: title…
  emptySub: string // …and the line under it
}

export const STAGES: StageInfo[] = [
  {
    key: 'applied',
    color: 'sand',
    empty: 'nothing applied yet.',
    emptySub: 'applications land here when you mark a posting applied.',
  },
  {
    key: 'assessment',
    color: 'blue',
    empty: 'no assessments.',
    emptySub: 'online assessments and take-homes collect here.',
  },
  { key: 'interview', color: 'pink', empty: 'no interviews.', emptySub: 'scheduled interviews collect here.' },
  {
    key: 'offer',
    color: 'green',
    empty: 'no offers yet.',
    emptySub: 'nothing has reached this stage. entries arrive here through [ → next stage ].',
  },
]

// A type guard: when it returns true, TypeScript narrows `s` to `Stage` in
// the caller, so `stageIndex` etc. accept it without a cast.
export function isOpen(s: AppStatus): s is Stage {
  return STAGES.some((x) => x.key === s)
}

export function stageIndex(s: Stage): number {
  return STAGES.findIndex((x) => x.key === s)
}

/** The stage [ → next stage ] moves to; null at offer or once closed. */
export function nextStage(s: AppStatus): Stage | null {
  return isOpen(s) ? (STAGES[stageIndex(s) + 1]?.key ?? null) : null
}

/** The stage's colour; null for rejected / withdrawn (drawn muted). */
export function stageColor(s: AppStatus): StatusColor | null {
  return isOpen(s) ? STAGES[stageIndex(s)].color : null
}

/** "new in stage" / "4d in stage", from the latest event. */
export function inStageText(app: Application): string {
  const days = app.stage_since ? daysSince(localYmd(app.stage_since)) : null
  if (days === null) return ''
  return days <= 0 ? 'new in stage' : `${days}d in stage`
}

/** "today" / "4d ago" for a full ISO timestamp. */
export function agoIso(iso: string | null): string {
  const days = iso ? daysSince(localYmd(iso)) : null
  if (days === null) return ''
  return days <= 0 ? 'today' : `${days}d ago`
}

export type TrackCell = {
  stage: StageInfo
  date: string | null // local 'YYYY-MM-DD' it was entered
  state: 'done' | 'current' | 'off'
}

/**
 * The summary's four-cell stage track. Each cell's date is when that stage
 * was last entered. Once closed there's no current stage: everything the
 * application reached reads as done, the rest as off.
 */
export function stageTrack(app: Application | null): TrackCell[] {
  if (!app) return STAGES.map((stage) => ({ stage, date: null, state: 'off' }))
  const reached = Math.max(
    0,
    ...app.events.map((e) => e.type).filter(isOpen).map(stageIndex),
  )
  const current = isOpen(app.status) ? stageIndex(app.status) : -1
  return STAGES.map((stage, i) => {
    const last = app.events.findLast((e) => e.type === stage.key)
    const state = i === current ? 'current' : i < (current >= 0 ? current : reached + 1) ? 'done' : 'off'
    return { stage, date: last && state !== 'off' ? localYmd(last.occurred_at) : null, state }
  })
}

const EVENT_LABELS: Record<AppStatus, string> = {
  applied: 'applied',
  assessment: 'moved to assessment',
  interview: 'moved to interview',
  offer: 'moved to offer',
  rejected: 'marked rejected',
  withdrawn: 'withdrawn',
}

export type TimelineEntry = {
  date: string // local 'YYYY-MM-DD'
  label: string
  kind: 'posting' | 'application'
  color: StatusColor | null // null = muted
}

/**
 * The record's // timeline: what we know about the posting (from `jobs`
 * fields) interleaved with the application's events. Oldest first; on the
 * same day posting entries come first, then events in the order they were
 * recorded.
 */
export function recordTimeline(job: Job | null, app: Application | null): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...(job ? postingEvents(job) : []).map((e) => ({ ...e, kind: 'posting' as const })),
    ...(app?.events ?? []).map((e) => ({
      date: localYmd(e.occurred_at),
      label: EVENT_LABELS[e.type],
      kind: 'application' as const,
      color: stageColor(e.type),
    })),
  ]
  // `sort` is stable, so equal dates keep the order above.
  return entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** Case-insensitive match on company or role, for the pipeline search. */
export function matchesQuery(app: Application, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || `${app.company} ${app.title}`.toLowerCase().includes(q)
}

export type StageCount = { key: Stage | 'closed'; n: number }

/** Per-stage counts plus closed, for the pipeline hero. */
export function stageCounts(apps: Application[]): StageCount[] {
  return [
    ...STAGES.map((s) => ({ key: s.key, n: apps.filter((a) => a.status === s.key).length })),
    { key: 'closed' as const, n: apps.filter((a) => !isOpen(a.status)).length },
  ]
}
