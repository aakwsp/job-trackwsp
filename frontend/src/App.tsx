import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// Mirrors `sync::SyncCounts` in src-tauri/src/sync/mod.rs. Tauri serializes
// the Rust struct with serde, so the field names must match exactly.
type SyncCounts = {
  inserted: number
  updated: number
  merged: number
  skipped: number
}

// One state value instead of separate `loading` / `counts` / `error`
// booleans, so impossible combinations (loading *and* errored) can't happen.
// `kind` is the tag TypeScript narrows on in the JSX below.
type SyncState =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'done'; counts: SyncCounts; at: string }
  | { kind: 'error'; message: string }

export default function App() {
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' })

  async function syncNow() {
    setSync({ kind: 'syncing' })
    try {
      // `invoke` calls the `#[tauri::command] fn sync_now` in lib.rs. The Rust
      // side blocks until the sheet fetch + DB writes finish (up to ~30s if
      // Apps Script needs its retries), and the promise resolves then.
      const counts = await invoke<SyncCounts>('sync_now')
      setSync({ kind: 'done', counts, at: new Date().toLocaleTimeString() })
    } catch (e) {
      // A Rust `Err(SyncError)` rejects the promise. SyncError serializes to
      // its Display string, so `e` is a plain string here.
      setSync({ kind: 'error', message: String(e) })
    }
  }

  return (
    <div>
      {/* `flex justify-between` puts the label left and the button right,
          like the muted count on other section headers. */}
      <div className="band flex items-center justify-between">
        <span>// job-trackwsp</span>
        <button
          type="button"
          onClick={syncNow}
          disabled={sync.kind === 'syncing'}
          className="cursor-pointer border border-rule-strong px-2 py-0.5 uppercase tracking-[0.12em] text-text-muted hover:border-text-muted hover:text-text disabled:cursor-wait disabled:opacity-50"
        >
          {sync.kind === 'syncing' ? 'syncing…' : 'sync now'}
        </button>
      </div>

      {sync.kind !== 'idle' && (
        <div className="border-b border-rule px-6 py-2.5 text-[11px] tracking-[0.08em] text-text-muted">
          {sync.kind === 'syncing' && 'fetching the sheet…'}
          {sync.kind === 'done' && (
            <>
              <span className="text-text">{sync.counts.inserted}</span> inserted
              {' · '}
              <span className="text-text">{sync.counts.updated}</span> updated
              {' · '}
              <span className="text-text">{sync.counts.merged}</span> merged
              {' · '}
              <span className="text-text">{sync.counts.skipped}</span> skipped
              <span className="text-text-dim"> — {sync.at}</span>
            </>
          )}
          {sync.kind === 'error' && (
            <span className="text-closing">{sync.message}</span>
          )}
        </div>
      )}

      <div className="row">
        <h2>placeholder</h2>
        <span className="tag">ready</span>
      </div>
    </div>
  )
}
