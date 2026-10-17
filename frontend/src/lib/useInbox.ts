import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import * as api from '../api'
import type { IgnoredRow, InboxDetail, InboxRow } from '../types'
import { loadSort, saveSort, type MailSort } from './inbox'

// INBOX's data (JT-18): the list, the open email's detail, the ignored
// list. Rust emits `inbox-changed` after routing runs and INBOX actions,
// and `mail-polled` after polls and extraction; both refresh this, so the
// lists keep themselves current with no polling from React.
// `notify` puts a line on the app's bottom bar (always visible, unlike the
// pane), optionally with an undo; errors go there too.
export type Notify = (t: { text: string; onUndo?: () => void }) => void

export function useInbox(active: boolean, notify: Notify) {
  const [rows, setRows] = useState<InboxRow[] | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<InboxDetail | null>(null)
  const [ignored, setIgnored] = useState<IgnoredRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The sort (JT-39), from `settings.inbox_sort`: read once here rather
  // than in Inbox, which remounts on every page switch. null while loading.
  const [sort, setSortState] = useState<MailSort | null>(null)
  useEffect(() => {
    loadSort().then(setSortState)
  }, [])
  const setSort = useCallback((s: MailSort) => {
    setSortState(s)
    saveSort(s)
  }, [])

  // Bumped by the events below; the effects re-fetch when it changes.
  const [version, setVersion] = useState(0)
  // Search (JT-18). `query` is what's typed; `applied` follows it ~120ms
  // later, so a burst of keystrokes is one search, not one per key.
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setApplied(query.trim()), 120)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!active) return
    const offs = [listen('inbox-changed', () => setVersion((v) => v + 1)), listen('mail-polled', () => setVersion((v) => v + 1))]
    return () => offs.forEach((p) => p.then((off) => off()))
  }, [active])

  useEffect(() => {
    if (!active) return
    let stale = false
    const q = applied || null
    api
      .inboxList(q)
      .then((r) => !stale && setRows(r))
      .catch((e) => !stale && setError(String(e)))
    api
      .inboxIgnored()
      .then((r) => !stale && setIgnored(r))
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [active, version, applied])

  useEffect(() => {
    if (!active || openId === null) return
    let stale = false
    api
      .inboxDetail(openId)
      .then((d) => !stale && setDetail(d))
      .catch((e) => !stale && setError(String(e)))
    return () => {
      stale = true
    }
  }, [active, openId, version])

  // Opening an email marks it read (as the board does on pick).
  const open = useCallback((id: number, markRead = true) => {
    setOpenId(id)
    if (markRead) api.inboxSetRead(id, true).catch((e) => setError(String(e)))
  }, [])

  // [ open in inbox → ] from the record (JT-41): open the email and ask
  // INBOX to show it, which it does once its rows are in (unfold the
  // section, clear a filter hiding it, scroll to it; see Inbox). The
  // search is cleared here so the list it waits for has every email.
  const [revealId, setRevealId] = useState<number | null>(null)
  const reveal = useCallback(
    (id: number) => {
      // Rows from a search may not have it: drop them and wait for the
      // full list (the fetch re-runs because `applied` changed).
      if (applied !== '') setRows(null)
      setQuery('')
      setApplied('')
      setRevealId(id)
      open(id)
    },
    [open, applied],
  )
  const revealed = useCallback(() => setRevealId(null), [])

  // Runs a routing action, then reloads at once: the open email's detail
  // straight away (so [ use this ] etc. show their effect immediately),
  // and the lists via `version` (the event would too, maybe later).
  // Resolves true on success; a failure is shown on the bottom line, which
  // is always on screen.
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setError(null)
    let ok = true
    try {
      await fn()
    } catch (e) {
      ok = false
      setError(String(e))
      notify({ text: String(e) })
    }
    if (openId !== null) {
      try {
        setDetail(await api.inboxDetail(openId))
      } catch {
        // the version bump below retries
      }
    }
    setVersion((v) => v + 1)
    return ok
  }

  // Updates one row in place, ahead of the reload (an email confirmed or
  // rejected leaves // checking at once).
  function patchRow(id: number, patch: Partial<InboxRow>) {
    setRows((rs) => rs && rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  return {
    rows,
    ignored,
    query,
    setQuery,
    searched: applied,
    openId,
    detail: detail && detail.email.id === openId ? detail : null,
    error,
    open,
    sort: sort ?? 'newest',
    setSort,
    revealId,
    reveal,
    revealed,
    act,
    patchRow,
    notify,
    setError,
  }
}
