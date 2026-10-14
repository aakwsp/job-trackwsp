import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from './api'
import type { Filters, Job } from './types'
import { EMPTY_FILTERS, NO_CITY, distinct, groupByCity, matchesFilters } from './lib/jobs'
import FilterBar from './components/FilterBar'
import CityGroup from './components/CityGroup'

// One value instead of separate `loading` / `jobs` / `error` so impossible
// combinations (loading *and* errored) can't happen. `kind` is the tag
// TypeScript narrows on below.
type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; jobs: Job[] }

export default function App() {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  // Bumping this re-runs the fetch effect (retry, or after a sync).
  const [reloadKey, setReloadKey] = useState(0)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  // Collapsed city names. A Set, replaced (never mutated) on every change so
  // React sees a new value.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)
  // One line of feedback under the header: sync result or a failed action.
  const [notice, setNotice] = useState<string | null>(null)

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
  const cities = useMemo(() => distinct(jobs, 'city'), [jobs])
  const sources = useMemo(() => distinct(jobs, 'source'), [jobs])
  const visible = useMemo(() => jobs.filter((j) => matchesFilters(j, filters)), [jobs, filters])
  const groups = useMemo(() => groupByCity(visible), [visible])

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

  // Optimistic: update the row now, roll back if Rust says no.
  async function toggleApplied(job: Job) {
    const next = !job.applied
    patchApplied(job.id, next)
    try {
      await api.setApplied(job.id, next)
    } catch (e) {
      patchApplied(job.id, job.applied)
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

  return (
    <div className="min-h-screen">
      {/* `sticky top-0` keeps the header + filters pinned while the list
          scrolls under them; it needs a solid background (`bg-bg`) or the
          rows would show through. */}
      <header className="sticky top-0 z-10 border-b border-rule-strong bg-bg">
        <div className="flex items-baseline justify-between px-6 pt-4">
          <h1 className="text-2xl">job-trackwsp</h1>
          <div className="flex items-baseline gap-4 text-[11px] text-text-muted">
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
        </div>

        <FilterBar
          filters={filters}
          cities={cities}
          sources={sources}
          onChange={setFilters}
          onCollapseAll={() => setCollapsed(new Set(jobs.map((j) => j.city ?? NO_CITY)))}
          onExpandAll={() => setCollapsed(new Set())}
        />

        {notice && (
          <div className="flex justify-between border-t border-rule px-6 py-1.5 text-[11px] text-text-muted">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="cursor-pointer hover:text-text">
              [ dismiss ]
            </button>
          </div>
        )}
      </header>

      <main>
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
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="cursor-pointer text-text hover:underline"
            >
              [ clear ]
            </button>
          </Message>
        )}

        {groups.map((g) => (
          <CityGroup
            key={g.city}
            city={g.city}
            jobs={g.jobs}
            collapsed={collapsed.has(g.city)}
            onToggle={toggleCity}
            onOpen={open}
            onToggleApplied={toggleApplied}
          />
        ))}
      </main>
    </div>
  )
}

function Message({ children }: { children: ReactNode }) {
  return <p className="px-6 py-10 text-text-muted">{children}</p>
}
