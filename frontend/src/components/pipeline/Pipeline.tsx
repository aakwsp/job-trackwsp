import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { Application, Stage } from '../../types'
import { STAGES, inStageText, isOpen, matchesQuery, type StageInfo } from '../../lib/applications'
import { localYmd, todayYmd } from '../../lib/jobs'
import { useReveal } from '../../lib/reveal'
import { clickable } from '../clickable'
import { field, textButton } from '../styles'

// Entries shown per column before "[ + n more ]". Keeps one busy column from
// pushing the closed band far down the page.
const COLUMN_CAP = 8

type Props = {
  apps: Application[]
  // The search box, owned by App so it survives page switches.
  query: string
  onQuery: (q: string) => void
  // The application open in the record, outlined in its column.
  selectedId: number | null
  notice: ReactNode
  onSelect: (app: Application) => void
  onAdvance: (app: Application) => void
  // Rejects with a message if Rust refused it.
  onAdd: (company: string, title: string, appliedOn: string) => Promise<void>
}

// PIPELINE: four stage columns (applied → assessment → interview → offer),
// then a collapsed band of closed ones. Every entry opens the same record
// as JOBS does, on its application tab.
export default function Pipeline({ apps, query, onQuery, selectedId, notice, onSelect, onAdvance, onAdd }: Props) {
  const [adding, setAdding] = useState(false)
  // Columns showing everything rather than the first COLUMN_CAP.
  const [uncapped, setUncapped] = useState<Set<Stage>>(new Set())
  const [closedOpen, setClosedOpen] = useState(false)

  const visible = useMemo(() => apps.filter((a) => matchesQuery(a, query)), [apps, query])
  // Newest applied first in every column ("sort: applied ↓"). `apps`
  // already arrives in that order from Rust; filtering keeps it.
  const byStage = useMemo(
    () => STAGES.map((s) => ({ stage: s, apps: visible.filter((a) => a.status === s.key) })),
    [visible],
  )
  // Most recently closed first.
  const closed = useMemo(
    () =>
      visible
        .filter((a) => !isOpen(a.status))
        .sort((a, b) => ((a.stage_since ?? '') < (b.stage_since ?? '') ? 1 : -1)),
    [visible],
  )

  function showAll(stage: Stage) {
    setUncapped((prev) => new Set(prev).add(stage))
  }

  return (
    <>
      {/* Sticky like the jobs toolbar; `.enter` with the same 160ms delay
          so it rises in right after the hero. */}
      <div
        className="enter sticky top-0 z-20 border-t border-rule-strong bg-bg"
        style={{ '--d': '160ms' } as CSSProperties}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 text-meta">
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="search company / role"
            aria-label="search applications by company or role"
            className={`${field} w-56`}
          />
          <button
            type="button"
            onClick={() => setAdding((x) => !x)}
            aria-expanded={adding}
            className={`${textButton} ${adding ? 'text-text' : 'text-text-muted'}`}
          >
            [ + add application ]
          </button>
          <span className="ml-auto text-text-dim">sort: applied ↓</span>
        </div>
        {/* Same open/close animation as the filter panel (`.reveal`). */}
        <div className="reveal" data-open={adding} inert={!adding}>
          <div className="reveal-inner">
            <AddForm
              onCancel={() => setAdding(false)}
              onAdd={async (c, t, d) => {
                await onAdd(c, t, d)
                setAdding(false)
              }}
            />
          </div>
        </div>
        {notice}
      </div>

      {/* One column under 900px; four side by side above. */}
      <div className="grid grid-cols-1 border-b border-rule min-[900px]:grid-cols-4">
        {byStage.map(({ stage, apps: entries }) => (
          <Column
            key={stage.key}
            stage={stage}
            entries={uncapped.has(stage.key) ? entries : entries.slice(0, COLUMN_CAP)}
            total={entries.length}
            searching={query.trim() !== ''}
            selectedId={selectedId}
            onShowAll={() => showAll(stage.key)}
            onSelect={onSelect}
            onAdvance={onAdvance}
          />
        ))}
      </div>

      <ClosedBand
        apps={closed}
        open={closedOpen}
        onToggle={() => setClosedOpen((x) => !x)}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </>
  )
}

function Column({
  stage,
  entries,
  total,
  searching,
  selectedId,
  onShowAll,
  onSelect,
  onAdvance,
}: {
  stage: StageInfo
  entries: Application[]
  total: number
  searching: boolean
  selectedId: number | null
  onShowAll: () => void
  onSelect: (app: Application) => void
  onAdvance: (app: Application) => void
}) {
  const { ref: revealRef, className: revealClass } = useReveal(`col:${stage.key}`)
  const last = stage.key === 'offer'
  return (
    <section aria-label={stage.key} className="min-w-0 border-rule min-[900px]:border-r min-[900px]:last:border-r-0">
      <div
        ref={revealRef}
        data-color={stage.color}
        className={`rise ${revealClass} flex h-9 items-center gap-2.5 border-b border-rule bg-bg pr-5 pl-6 text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase`}
      >
        <span aria-hidden className="flag mark-xs" data-color={stage.color} />
        <h2 className="font-mono">// {stage.key}</h2>
        <span className="ml-auto tracking-[0.04em] text-text">{total}</span>
      </div>

      {entries.map((app) => (
        <Entry
          key={app.id}
          app={app}
          stage={stage}
          canAdvance={!last}
          selected={app.id === selectedId}
          onSelect={onSelect}
          onAdvance={onAdvance}
        />
      ))}

      {total === 0 && (
        <div className="px-6 pt-7 pb-8">
          <p className="font-serif text-[1.25rem] text-text-dim">{searching ? 'no matches.' : stage.empty}</p>
          {!searching && <p className="mt-2.5 text-[0.65625rem] leading-[1.7] text-text-dim">{stage.emptySub}</p>}
        </div>
      )}

      {total > entries.length && (
        <button
          type="button"
          onClick={onShowAll}
          className={`${textButton} h-11 w-full px-6 text-left text-[0.6875rem] text-text-muted`}
        >
          [ + {total - entries.length} more ]
        </button>
      )}
    </section>
  )
}

function Entry({
  app,
  stage,
  canAdvance,
  selected,
  onSelect,
  onAdvance,
}: {
  app: Application
  stage: StageInfo
  canAdvance: boolean
  selected: boolean
  onSelect: (app: Application) => void
  onAdvance: (app: Application) => void
}) {
  // Rises in like a job card (lib/reveal.ts). Keyed by application id, so
  // an entry moving to the next column doesn't replay its entrance.
  const { ref: revealRef, className: revealClass } = useReveal(`app:${app.id}`)
  const next = STAGES[STAGES.findIndex((s) => s.key === app.status) + 1]
  return (
    // `group`: lets a child style itself by this element's state —
    // `group-hover:visible` on the button below means "visible while the
    // entry is hovered". `group-focus-within` does the same for keyboard
    // focus anywhere inside, so Tab can reach the button too.
    <div
      {...clickable(() => onSelect(app))}
      // Lets App's hover shortcut (o) find this application.
      data-app-id={app.id}
      ref={revealRef}
      data-color={stage.color}
      className={`group rise ${revealClass} relative cursor-pointer border-b border-rule pt-4 pr-4 pb-3.5 pl-6 transition-colors duration-(--motion) hover:bg-bg-hover focus-within:bg-bg-hover ${
        selected ? 'z-[1] outline outline-text -outline-offset-1' : ''
      }`}
    >
      <div aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-(--c)" />
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="min-w-0 truncate text-[1.25rem] leading-[1.05] lowercase" title={app.company}>
          {app.company}
        </h3>
        {canAdvance && next && (
          <button
            type="button"
            // The entry itself is clickable (opens the record); without
            // stopPropagation this click would bubble up and open it too.
            onClick={(e) => {
              e.stopPropagation()
              onAdvance(app)
            }}
            aria-label={`move ${app.company} to ${next.key}`}
            className="invisible ml-auto h-7 shrink-0 cursor-pointer border border-rule-strong bg-bg px-2 text-[0.65625rem] whitespace-nowrap text-text group-focus-within:visible group-hover:visible hover:border-text hover:bg-text hover:text-bg"
          >
            [ → next stage ]
          </button>
        )}
      </div>
      <p className="mt-2 truncate text-meta text-text-muted" title={app.title}>
        {app.title || '—'}
      </p>
      <p className="mt-2.5 text-[0.65625rem] text-text-dim">
        applied {app.applied_at ? localYmd(app.applied_at) : '—'} · {inStageText(app)}
      </p>
    </div>
  )
}

function ClosedBand({
  apps,
  open,
  onToggle,
  selectedId,
  onSelect,
}: {
  apps: Application[]
  open: boolean
  onToggle: () => void
  selectedId: number | null
  onSelect: (app: Application) => void
}) {
  const { ref: revealRef, className: revealClass } = useReveal('band:closed')
  return (
    <section aria-label="closed">
      <button
        type="button"
        ref={revealRef}
        onClick={onToggle}
        aria-expanded={open}
        className={`rise ${revealClass} flex h-9 w-full cursor-pointer items-center gap-2.5 border-b border-rule bg-bg px-6 text-left text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase hover:text-text`}
      >
        <span>{open ? '-' : '+'} // closed</span>
        <span className="tracking-[0.04em] text-text">{apps.length}</span>
        {/* The collapsed band still says who: "visier — rejected · ...". */}
        {!open && (
          <span className="ml-auto min-w-0 truncate tracking-[0.02em] text-text-dim normal-case">
            {apps.map((a) => `${a.company.toLowerCase()} — ${a.status}`).join('   ·   ')}
          </span>
        )}
      </button>
      <div className="reveal" data-open={open} inert={!open}>
        <div className="reveal-inner">
          <div className="grid grid-cols-1 min-[900px]:grid-cols-4">
            {apps.map((a) => (
              <div
                key={a.id}
                {...clickable(() => onSelect(a))}
                data-app-id={a.id}
                className={`cursor-pointer border-r border-b border-rule py-3.5 pr-4 pl-6 hover:bg-bg-hover ${
                  a.id === selectedId ? 'outline outline-text -outline-offset-1' : ''
                }`}
              >
                <h3 className="truncate text-[1.125rem] leading-[1.05] text-text-muted lowercase">{a.company}</h3>
                <p className="mt-[0.4375rem] truncate text-[0.71875rem] text-text-dim">{a.title || '—'}</p>
                <p className="mt-2 text-[0.65625rem] text-text-dim">
                  {a.status} {a.stage_since ? localYmd(a.stage_since) : ''} · applied{' '}
                  {a.applied_at ? localYmd(a.applied_at) : '—'}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

// [ + add application ]: company, role and the date applied (today by
// default). Lands in the applied column with no posting attached.
function AddForm({
  onAdd,
  onCancel,
}: {
  onAdd: (company: string, title: string, appliedOn: string) => Promise<void>
  onCancel: () => void
}) {
  const [company, setCompany] = useState('')
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(todayYmd)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    // A <form> submits by reloading the page; we handle it ourselves.
    e.preventDefault()
    setBusy(true)
    try {
      await onAdd(company, title, date)
      setCompany('')
      setTitle('')
      setDate(todayYmd())
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    // A real <form>, so Enter in any field submits it.
    <form onSubmit={submit} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-rule px-6 py-3 text-meta">
      <span className="text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase">// new</span>
      <input
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        placeholder="company"
        aria-label="company"
        required
        className={`${field} w-44`}
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="role"
        aria-label="role"
        className={`${field} w-72`}
      />
      {/* `type="date"` gives a native picker; its value is 'YYYY-MM-DD',
          exactly what Rust expects. `[color-scheme:dark]` asks WebKit to
          draw the picker's icon for a dark background. */}
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        aria-label="date applied"
        className={`${field} [color-scheme:dark]`}
      />
      <button type="submit" disabled={busy} className={`${textButton} text-text disabled:opacity-50`}>
        [ add ]
      </button>
      <button type="button" onClick={onCancel} className={`${textButton} text-text-muted`}>
        [ cancel ]
      </button>
      {error && <span className="text-pink">{error}</span>}
    </form>
  )
}
