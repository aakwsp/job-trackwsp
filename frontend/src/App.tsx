import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as api from './api'
import type { Application, Filters, Job } from './types'
import { DEFAULT_FILTERS, NO_CITY, groupByCity, matchesFilters } from './lib/jobs'
import { loadFilters, rowCounts, saveFilters } from './lib/filters'
import { loadView, saveView, type ViewMode } from './lib/view'
import { useUiScale } from './lib/useUiScale'
import FilterBar from './components/FilterBar'
import CityGroup from './components/CityGroup'
import Record from './components/record/Record'
import type { RecordFrom, Tab } from './lib/record'
import Pipeline from './components/pipeline/Pipeline'
import { stageCounts } from './lib/applications'
import TopStrip from './components/TopStrip'
import AppHeader from './components/AppHeader'
import Hero from './components/Hero'
import AppFooter from './components/AppFooter'
import Placeholder from './components/Placeholder'
import { PAGES, type Page } from './lib/page'
import RevealProvider from './components/RevealProvider'

// One value instead of separate `loading` / `jobs` / `error` so impossible
// combinations (loading *and* errored) can't happen. `kind` is the tag
// TypeScript narrows on below.
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; jobs: Job[]; apps: Application[] }

// Which record is open. Both ids where known: from PIPELINE it's the
// application (and its posting, if any); from JOBS the posting (and its
// application once there is one). Ids rather than objects, so the record
// always reads the live rows, and marking applied in JOBS shows up in it
// (and in PIPELINE) as soon as App's state has the new application.
// The pipeline hero's stripe: each stage in its colour, closed in the rule
// colour (null).
const STRIPE_COLORS = { applied: 'sand', assessment: 'blue', interview: 'pink', offer: 'green', closed: null } as const

// The bottom confirmation line after a hover shortcut.
type Toast = { id: number; text: string; onUndo?: () => void }
const TOAST_MS = 5000

type OpenRecord = { jobId: number | null; appId: number | null; from: RecordFrom; tab: Tab }

export default function App() {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  // Bumping this re-runs the fetch effect (retry, or after a sync).
  const [reloadKey, setReloadKey] = useState(0)
  // Lazy initializer, like `view` below: last session's filters, read once.
  const [filters, setFilters] = useState<Filters>(loadFilters)
  // Collapsed city names. A Set, replaced (never mutated) on every change so
  // React sees a new value.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Passing a function (not `loadView()`) makes it a lazy initializer:
  // React calls it once on mount instead of reading storage every render.
  const [view, setView] = useState<ViewMode>(loadView)
  const scale = useUiScale()
  const [syncing, setSyncing] = useState(false)
  // One line of feedback under the header: sync result or a failed action.
  const [notice, setNotice] = useState<string | null>(null)
  const [record, setRecord] = useState<OpenRecord | null>(null)
  // The confirmation line at the bottom after a hover shortcut. A new
  // object per toast, so the timer effect below restarts for each one.
  const [toast, setToastState] = useState<Toast | null>(null)
  // Stamps each toast with a fresh id, so two in a row with the same text
  // still count as different (new timer, replayed fade).
  const toastSeq = useRef(0)
  const setToast = (t: Omit<Toast, 'id'> | null) =>
    setToastState(t && { ...t, id: ++toastSeq.current })
  const [page, setPage] = useState<Page>('jobs')

  // <main> is the one scrolling element; every view scrolls inside it.
  const mainRef = useRef<HTMLElement>(null)
  // Where each view was scrolled to when you left it. A ref, not state:
  // changing it shouldn't re-render anything.
  const scrollByPage = useRef<Partial<Record<Page, number>>>({})
  // The sticky toolbar's height, so the city bands can stick right under it.
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarH, setToolbarH] = useState(0)

  useEffect(() => {
    // If the effect re-runs (or StrictMode mounts twice in dev) before the
    // promise settles, the stale result is ignored instead of overwriting a
    // newer one.
    let stale = false
    // Both lists in parallel; the page is ready once both are in.
    Promise.all([api.listJobs(), api.listApplications()])
      .then(([jobs, apps]) => !stale && setLoad({ kind: 'ready', jobs, apps }))
      .catch((e) => !stale && setLoad({ kind: 'error', message: String(e) }))
    return () => {
      stale = true
    }
  }, [reloadKey])

  const jobs = useMemo(() => (load.kind === 'ready' ? load.jobs : []), [load])
  const apps = useMemo(() => (load.kind === 'ready' ? load.apps : []), [load])

  // useMemo: only recompute when the inputs change, not on every render
  // (e.g. while `syncing` flips). Cheap at 218 rows, but it also keeps the
  // derived data out of state, so it can never drift from `jobs`.
  const visible = useMemo(
    () => jobs.filter((j) => matchesFilters(j, filters)),
    [jobs, filters],
  )
  const groups = useMemo(() => groupByCity(visible), [visible])

  // Resolve the open record against the live lists. The application is
  // looked up by its own id first, then by posting: that's how one opened
  // from JOBS picks up the application [ mark applied ] just created, and
  // how one opened from PIPELINE survives an undo that removes it.
  const recordApp = record
    ? (apps.find((a) => a.id === record.appId) ?? apps.find((a) => record.jobId !== null && a.job_id === record.jobId) ?? null)
    : null
  const recordJobId = record?.jobId ?? recordApp?.job_id ?? null
  const recordJob = jobs.find((j) => j.id === recordJobId) ?? null

  // Restore the scroll position of the view just switched to. A *layout*
  // effect runs after React updates the DOM but before the browser paints,
  // so the view never shows at the wrong position first.
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = scrollByPage.current[page] ?? 0
  }, [page])

  // Track the toolbar's height (it changes when chips wrap or the UI scale
  // changes). ResizeObserver calls back whenever the element's size changes.
  // Re-run per page: the toolbar only exists on the jobs view.
  useLayoutEffect(() => {
    const el = toolbarRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setToolbarH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [page])

  function switchPage(p: Page) {
    if (p === page) return
    if (mainRef.current) scrollByPage.current[page] = mainRef.current.scrollTop
    setPage(p)
  }

  const counts = useMemo(() => rowCounts(jobs, filters), [jobs, filters])

  // Every filter change goes through here so it's saved for next launch.
  function changeFilters(next: Filters) {
    setFilters(next)
    saveFilters(next)
  }

  // Each toast disappears after TOAST_MS. A newer one replaces it (and its
  // timer) before then.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(t)
  }, [toast])

  // Hover shortcuts on list items: "a" marks the posting under the mouse
  // applied, "o" opens it. Items carry `data-job-id` / `data-app-id`, so
  // instead of tracking hover in state, the handler asks the DOM which item
  // is hovered right now (`:hover`), falling back to the one with keyboard
  // focus. No dependency list, for the same reason as Record's handler: it
  // always sees the current jobs and functions.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // An open record has its own keys, and they win.
      if (record) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      // Typing in search, city, notes or the add form: letters are text.
      if (e.target instanceof Element && e.target.closest('input, textarea, select')) return
      if (e.key !== 'a' && e.key !== 'o') return

      const sel = '[data-job-id], [data-app-id]'
      const el =
        document.querySelector<HTMLElement>('[data-job-id]:hover, [data-app-id]:hover') ??
        (document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(sel) : null)
      if (!el) return
      // `dataset` is the element's data-* attributes, camelCased.
      const app = el.dataset.appId ? apps.find((a) => a.id === Number(el.dataset.appId)) : undefined
      const jobId = el.dataset.jobId ? Number(el.dataset.jobId) : app?.job_id
      const job = jobs.find((j) => j.id === jobId)

      if (e.key === 'o') {
        if (job?.url) open(job)
        else setToast({ text: 'no posting link' })
      } else if (job && !job.applied) {
        markApplied(job)
        // A stray "a" is easy to press, so say what happened and offer the
        // way back for a few seconds.
        setToast({
          text: `applied · ${job.company.toLowerCase()}`,
          onUndo: () => unapply({ ...job, applied: true, app_status: 'applied' }),
        })
      } else if (job || app) {
        setToast({ text: `already applied · ${(job?.company ?? app?.company ?? '').toLowerCase()}` })
      } else return
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  // useCallback: Record's close-timer effect depends on `onClose`, so it
  // must stay the same function across App re-renders, or the 400ms safety
  // timer would restart on every one.
  const closeRecord = useCallback(() => setRecord(null), [])

  function changeView(v: ViewMode) {
    setView(v)
    saveView(v)
  }

  function retry() {
    setLoad({ kind: 'loading' })
    setReloadKey((k) => k + 1)
  }

  // Change some fields of one job locally. The updater form
  // `setLoad(prev => ...)` reads the latest state, so two quick clicks
  // don't clobber each other. `Partial<Job>`: any subset of Job's fields.
  function patchJob(id: number, patch: Partial<Job>) {
    setLoad((prev) =>
      prev.kind === 'ready' ? { ...prev, jobs: prev.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) } : prev,
    )
  }

  // Same idea for applications. `replaceApp` swaps in the row Rust returned
  // after a pipeline move; `refreshApps` refetches them all, for changes
  // made through `set_applied`, which creates or deletes one.
  function setApps(update: (apps: Application[]) => Application[]) {
    setLoad((prev) => (prev.kind === 'ready' ? { ...prev, apps: update(prev.apps) } : prev))
  }
  const replaceApp = (app: Application) => setApps((all) => all.map((a) => (a.id === app.id ? app : a)))
  async function refreshApps() {
    const fresh = await api.listApplications()
    setApps(() => fresh)
  }

  // [ mark applied ]. Optimistic on the JOBS row: it flips now (with today
  // as the applied date) and rolls back if Rust says no. Then the
  // applications are refetched, which is what puts it in PIPELINE's applied
  // column and gives the open record its application tab.
  async function markApplied(job: Job) {
    patchJob(job.id, { applied: true, applied_at: new Date().toISOString(), app_status: 'applied' })
    try {
      await api.setApplied(job.id, true)
      await refreshApps()
    } catch (e) {
      patchJob(job.id, { applied: false, applied_at: null, app_status: null })
      setNotice(String(e))
    }
  }

  // Undo of [ mark applied ]. Rust refuses (and we roll back) if the
  // application has already moved past 'applied', so this can't throw away
  // an interview.
  async function unapply(job: Job) {
    patchJob(job.id, { applied: false, applied_at: null, app_status: null })
    try {
      await api.setApplied(job.id, false)
      await refreshApps()
    } catch (e) {
      patchJob(job.id, { applied: true, applied_at: job.applied_at, app_status: job.app_status })
      setNotice(String(e))
    }
  }

  // The pipeline moves. Not optimistic: the event and the new status are
  // written in one transaction in Rust, and the column only changes once
  // that has committed. It's a local SQLite write, so there's no visible
  // wait.
  async function move(call: (id: number) => Promise<Application>, app: Application) {
    try {
      const updated = await call(app.id)
      replaceApp(updated)
      // The JOBS row carries the status too (for the rejected square), so
      // keep it in step.
      if (updated.job_id !== null) patchJob(updated.job_id, { app_status: updated.status })
    } catch (e) {
      setNotice(String(e))
    }
  }

  async function addApplication(company: string, title: string, appliedOn: string) {
    const app = await api.addApplication(company, title, appliedOn || null)
    setApps((all) => [app, ...all])
  }

  // Not optimistic: the record keeps the text either way, and only the
  // stored copy changes here, once the DB has it. Errors go back to the
  // record (which shows them by the textarea) rather than to `notice`,
  // which is hidden behind it. With a posting, the note lives wherever
  // `jobs::save_notes` keeps it; without one, on the application.
  async function saveRecordNotes(job: Job | null, app: Application | null, body: string) {
    const notes = body.trim() || null
    if (job) {
      await api.saveNotes(job.id, body)
      patchJob(job.id, { notes })
    } else if (app) {
      await api.saveApplicationNotes(app.id, body)
    }
    if (app) setApps((all) => all.map((a) => (a.id === app.id ? { ...a, notes } : a)))
  }

  async function open(job: Job) {
    if (!job.url) return
    try {
      await api.openPosting(job.url)
    } catch (e) {
      setNotice(String(e))
    }
  }

  async function sync() {
    setSyncing(true)
    setNotice(null)
    try {
      const c = await api.syncNow()
      setNotice(`synced: ${c.inserted} new · ${c.updated} updated · ${c.merged} merged · ${c.skipped} skipped`)
      setReloadKey((k) => k + 1)
    } catch (e) {
      setNotice(String(e))
    } finally {
      setSyncing(false)
    }
  }

  function toggleCity(city: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(city)) next.delete(city)
      else next.add(city)
      return next
    })
  }

  const current = PAGES.find((p) => p.page === page)!

  const noticeLine = notice && (
    <div className="flex justify-between border-t border-rule px-6 py-1.5 text-meta text-text-muted">
      <span>{notice}</span>
      <button type="button" onClick={() => setNotice(null)} className="cursor-pointer hover:text-text">
        [ dismiss ]
      </button>
    </div>
  )

  // Pipeline hero: per-stage counts as the subtitle, and the left stripe
  // split in proportion to them (closed in the rule colour).
  const tally = stageCounts(apps)
  const pipelineHero = {
    subtitle: (
      <span>
        {tally.map((c, i) => (
          <span key={c.key}>
            <span className="text-text">{c.n}</span> {c.key}
            {i < tally.length - 1 && <span className="text-text-dim"> · </span>}
          </span>
        ))}
      </span>
    ),
    stripe: tally.map((c) => ({ key: c.key, color: STRIPE_COLORS[c.key], n: c.n })),
    aside: <span className="shrink-0 text-meta text-text-muted">{apps.length} tracked</span>,
  }

  return (
    // A full-height column: the strip and header keep their natural height
    // and are always visible; <main> takes the rest (`flex-1`) and scrolls
    // on its own. Hero, toolbar, list and footer all scroll inside <main>,
    // and the toolbar is `sticky top-0` within it, so it stops right under
    // the header once the hero has scrolled away.
    <div className="flex h-screen flex-col">
      <TopStrip />
      <AppHeader page={page} onPage={switchPage} />

      <main
        ref={mainRef}
        className="flex flex-1 flex-col overflow-y-auto"
        // A CSS variable set from React; the city bands read it (CityGroup).
        // The cast is because TypeScript's style type doesn't know custom
        // properties.
        style={{ '--toolbar-h': `${toolbarH}px` } as CSSProperties}
      >
        {/* One container per page. `key={page}` makes React mount a new one
            on every switch, so everything inside starts fresh: the hero and
            toolbar replay their entrance (CSS animations run when an element
            first appears), and the new RevealProvider forgets which cards
            have revealed, so they rise in again from the top. */}
        <div key={page} className="flex flex-1 flex-col">
          <RevealProvider>
            <Hero
              title={current.title}
              subtitle={page === 'pipeline' && load.kind === 'ready' ? pipelineHero.subtitle : current.subtitle}
              stripe={page === 'pipeline' && apps.length > 0 ? pipelineHero.stripe : undefined}
              aside={
                page === 'pipeline' ? (
                  load.kind === 'ready' && pipelineHero.aside
                ) : 
                page === 'jobs' && (
                  <div className="flex shrink-0 items-baseline gap-4 text-meta text-text-muted">
                    {load.kind === 'ready' && (
                      <span>
                        {visible.length} / {jobs.length}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={sync}
                      disabled={syncing}
                      className="cursor-pointer hover:text-text disabled:cursor-wait disabled:opacity-50"
                    >
                      {syncing ? '[ syncing… ]' : '[ sync ]'}
                    </button>
                  </div>
                )
              }
            />

            {page === 'jobs' ? (
              <>
                {/* `z-20` keeps the toolbar (and the filter panel that drops out
                    of it) above the city bands, which are `z-10`. */}
                <div
                ref={toolbarRef}
                className="enter sticky top-0 z-20 border-t border-rule-strong bg-bg"
                style={{ '--d': '160ms' } as CSSProperties}
              >
                  <FilterBar
                    filters={filters}
                    onChange={changeFilters}
                    counts={counts}
                    view={view}
                    onView={changeView}
                    scale={scale}
                    onCollapseAll={() => setCollapsed(new Set(jobs.map((j) => j.city ?? NO_CITY)))}
                    onExpandAll={() => setCollapsed(new Set())}
                  />
                  {noticeLine}
                </div>

                {load.kind === 'loading' && <Message>loading postings…</Message>}

                {load.kind === 'error' && (
                  <Message>
                    could not load postings: {load.message}{' '}
                    <button type="button" onClick={retry} className="cursor-pointer text-text hover:underline">
                      [ retry ]
                    </button>
                  </Message>
                )}

                {load.kind === 'ready' && jobs.length === 0 && (
                  <Message>no postings yet — run a sync to pull the inbox.</Message>
                )}

                {load.kind === 'ready' && jobs.length > 0 && visible.length === 0 && (
                  <Message>
                    nothing matches these filters.{' '}
                    <button
                      type="button"
                      onClick={() => changeFilters(DEFAULT_FILTERS)}
                      className="cursor-pointer text-text hover:underline"
                    >
                      [ clear ]
                    </button>
                  </Message>
                )}

                {/* Same trick for DEFAULT / COMPACT / LINE: switching swaps the
                    list instantly and fades in this one container, rather than
                    animating ~330 cards. */}
                <div key={view} className="fade-in">
                  {groups.map((g) => (
                    <CityGroup
                      key={g.city}
                      city={g.city}
                      jobs={g.jobs}
                      view={view}
                      collapsed={collapsed.has(g.city)}
                      onToggle={toggleCity}
                      onSelect={(job) => setRecord({ jobId: job.id, appId: null, from: 'jobs', tab: 'posting' })}
                      onOpen={open}
                    />
                  ))}
                </div>
              </>
            ) : page === 'pipeline' ? (
              <>
                {load.kind === 'loading' && <Message>loading applications…</Message>}
                {load.kind === 'error' && (
                  <Message>
                    could not load applications: {load.message}{' '}
                    <button type="button" onClick={retry} className="cursor-pointer text-text hover:underline">
                      [ retry ]
                    </button>
                  </Message>
                )}
                {load.kind === 'ready' && (
                  <Pipeline
                    apps={apps}
                    selectedId={recordApp?.id ?? null}
                    notice={noticeLine}
                    onSelect={(app) => setRecord({ jobId: app.job_id, appId: app.id, from: 'pipeline', tab: 'application' })}
                    onAdvance={(app) => move(api.advanceStage, app)}
                    onAdd={addApplication}
                  />
                )}
              </>
            ) : (
              <Placeholder what={current.title} />
            )}

            <AppFooter />
          </RevealProvider>
        </div>
      </main>

      {record && (recordJob || recordApp) && (
        <Record
          // A different record gets a fresh panel (and slide-in). Keyed by
          // what it was opened on, so marking applied (which adds an
          // application to the same record) doesn't remount it.
          key={`${record.from}:${record.jobId ?? `a${record.appId}`}`}
          job={recordJob}
          app={recordApp}
          from={record.from}
          initialTab={record.tab}
          onClose={closeRecord}
          onOpen={open}
          onMarkApplied={markApplied}
          onUnapply={unapply}
          onAdvance={(app) => move(api.advanceStage, app)}
          onReject={(app) => move(api.markRejected, app)}
          onUndoEvent={(app) => move(api.undoEvent, app)}
          onSaveNotes={(body) => saveRecordNotes(recordJob, recordApp, body)}
        />
      )}

      {toast && (
        // `role="status"`: screen readers announce the text when it
        // appears, without moving focus. `key` replays the fade for each
        // new toast.
        <div
          key={toast.id}
          role="status"
          className="fade-in fixed inset-x-0 bottom-0 z-50 flex items-center gap-3 border-t border-rule-strong bg-bg px-6 py-2 text-meta text-text-muted"
        >
          <span className="text-text">{toast.text}</span>
          {toast.onUndo && (
            <>
              <span className="text-text-dim">—</span>
              <button
                type="button"
                onClick={() => {
                  toast.onUndo?.()
                  setToast(null)
                }}
                className="cursor-pointer hover:text-text"
              >
                [ undo ]
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Message({ children }: { children: ReactNode }) {
  return <p className="px-6 py-10 text-text-muted">{children}</p>
}
