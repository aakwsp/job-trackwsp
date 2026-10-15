import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as api from './api'
import type { Filters, Job } from './types'
import { DEFAULT_FILTERS, NO_CITY, groupByCity, matchesFilters } from './lib/jobs'
import { loadFilters, rowCounts, saveFilters } from './lib/filters'
import { loadView, saveView, type ViewMode } from './lib/view'
import { useUiScale } from './lib/useUiScale'
import FilterBar from './components/FilterBar'
import CityGroup from './components/CityGroup'
import JobDetail from './components/JobDetail'
import TopStrip from './components/TopStrip'
import AppHeader from './components/AppHeader'
import Hero from './components/Hero'
import AppFooter from './components/AppFooter'
import Placeholder from './components/Placeholder'
import { PAGES, type Page } from './lib/page'

// One value instead of separate `loading` / `jobs` / `error` so impossible
// combinations (loading *and* errored) can't happen. `kind` is the tag
// TypeScript narrows on below.
type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; jobs: Job[] }

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
  // Job ids applied since the last [ sync ]; the detail card offers
  // [ undo ] for these.
  const [recentlyApplied, setRecentlyApplied] = useState<ReadonlySet<number>>(new Set())
  // The posting shown in the detail card. An id rather than the Job itself,
  // so the card reads the live row from `jobs` and sees [ mark applied ]
  // take effect instead of holding a stale copy.
  const [selectedId, setSelectedId] = useState<number | null>(null)
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
    api
      .listJobs()
      .then((jobs) => !stale && setLoad({ kind: 'ready', jobs }))
      .catch((e) => !stale && setLoad({ kind: 'error', message: String(e) }))
    return () => {
      stale = true
    }
  }, [reloadKey])

  const jobs = useMemo(() => (load.kind === 'ready' ? load.jobs : []), [load])

  // useMemo: only recompute when the inputs change, not on every render
  // (e.g. while `syncing` flips). Cheap at 218 rows, but it also keeps the
  // derived data out of state, so it can never drift from `jobs`.
  const visible = useMemo(
    () => jobs.filter((j) => matchesFilters(j, filters)),
    [jobs, filters],
  )
  const groups = useMemo(() => groupByCity(visible), [visible])
  const selected = jobs.find((j) => j.id === selectedId) ?? null

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

  function viewPipeline() {
    setSelectedId(null)
    switchPage('pipeline')
  }
  const counts = useMemo(() => rowCounts(jobs, filters), [jobs, filters])

  // Every filter change goes through here so it's saved for next launch.
  function changeFilters(next: Filters) {
    setFilters(next)
    saveFilters(next)
  }

  function changeView(v: ViewMode) {
    setView(v)
    saveView(v)
  }

  function retry() {
    setLoad({ kind: 'loading' })
    setReloadKey((k) => k + 1)
  }

  // Flip one job's flag locally. The updater form `setLoad(prev => ...)`
  // reads the latest state, so two quick clicks don't clobber each other.
  function patchApplied(id: number, applied: boolean) {
    setLoad((prev) =>
      prev.kind === 'ready' ? { ...prev, jobs: prev.jobs.map((j) => (j.id === id ? { ...j, applied } : j)) } : prev,
    )
  }

  // [ mark applied ] in the detail card. Optimistic: the row flips now and
  // rolls back if Rust says no.
  async function markApplied(job: Job) {
    patchApplied(job.id, true)
    setRecentlyApplied((prev) => new Set(prev).add(job.id))
    try {
      await api.setApplied(job.id, true)
    } catch (e) {
      patchApplied(job.id, false)
      setNotice(String(e))
    }
  }

  async function undo(job: Job) {
    patchApplied(job.id, false)
    try {
      await api.setApplied(job.id, false)
      setRecentlyApplied((prev) => {
        const next = new Set(prev)
        next.delete(job.id)
        return next
      })
    } catch (e) {
      patchApplied(job.id, true)
      setNotice(String(e))
    }
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
      // "Until the next sync": applied rows lose [ undo ] and, with show
      // applied off, drop out of the list on the reload below.
      setRecentlyApplied(new Set())
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
            on every switch, which replays its `.fade-in` animation (CSS
            animations run when an element first appears) and gives each
            view a fresh Hero and scroll observer. */}
        <div key={page} className="fade-in flex flex-1 flex-col">
          <Hero
            title={current.title}
            subtitle={current.subtitle}
            aside={
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
              <div ref={toolbarRef} className="sticky top-0 z-20 border-t border-rule-strong bg-bg">
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
                {notice && (
                  <div className="flex justify-between border-t border-rule px-6 py-1.5 text-meta text-text-muted">
                    <span>{notice}</span>
                    <button type="button" onClick={() => setNotice(null)} className="cursor-pointer hover:text-text">
                      [ dismiss ]
                    </button>
                  </div>
                )}
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
                    onSelect={(job) => setSelectedId(job.id)}
                    onOpen={open}
                  />
                ))}
              </div>
            </>
          ) : (
            <Placeholder what={current.title} />
          )}

          <AppFooter />
        </div>
      </main>

      {selected && (
        <JobDetail
          // A different posting gets a fresh drawer (and slide-in).
          key={selected.id}
          job={selected}
          undoable={recentlyApplied.has(selected.id)}
          onClose={() => setSelectedId(null)}
          onOpen={open}
          onMarkApplied={markApplied}
          onUndo={undo}
          onViewPipeline={viewPipeline}
        />
      )}
    </div>
  )
}

function Message({ children }: { children: ReactNode }) {
  return <p className="px-6 py-10 text-text-muted">{children}</p>
}
