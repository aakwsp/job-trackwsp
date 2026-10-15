import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import * as api from '../api'
import type { IgnoredRow, InboxDetail, InboxRow } from '../types'

// INBOX's data (JT-18): the list, the open email's detail, the ignored
// list. Rust emits `inbox-changed` after routing runs and INBOX actions,
// and `mail-polled` after polls and extraction; both refresh this, so the
// lists keep themselves current with no polling from React.
export function useInbox(active: boolean) {
  const [rows, setRows] = useState<InboxRow[] | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<InboxDetail | null>(null)
  const [ignored, setIgnored] = useState<IgnoredRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped by the events below; the effects re-fetch when it changes.
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!active) return
    const offs = [listen('inbox-changed', () => setVersion((v) => v + 1)), listen('mail-polled', () => setVersion((v) => v + 1))]
    return () => offs.forEach((p) => p.then((off) => off()))
  }, [active])

  useEffect(() => {
    if (!active) return
    let stale = false
    api
      .inboxList()
      .then((r) => !stale && setRows(r))
      .catch((e) => !stale && setError(String(e)))
    api
      .inboxIgnored()
      .then((r) => !stale && setIgnored(r))
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [active, version])

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

  // Runs a routing action, then reloads (the event usually does that too;
  // this makes it immediate even if the event arrives late).
  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(String(e))
    } finally {
      setVersion((v) => v + 1)
    }
  }

  return { rows, ignored, openId, detail: detail && detail.email.id === openId ? detail : null, error, open, act, setError }
}
