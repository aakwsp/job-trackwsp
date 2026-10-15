import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import * as api from '../api'
import type { MailStatus } from '../types'

// The mail poller's status for the QUEUE status line (JT-14). Rust polls
// on its own too, so besides asking on open, this listens for the
// `mail-polled` event Rust emits after every poll.
export function useMail(active: boolean) {
  const [status, setStatus] = useState<MailStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // [ check mail ] pressed and not back yet. Separate from
  // `status.checking`, which is also true for background polls.
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!active) return
    let stale = false
    api
      .mailStatus()
      .then((s) => !stale && setStatus(s))
      .catch((e) => !stale && setError(String(e)))
    // `listen` resolves with an unlisten function. The effect can't wait
    // for it, so cleanup chains onto the promise instead.
    const unlisten = listen<MailStatus>('mail-polled', (e) => setStatus(e.payload))
    return () => {
      stale = true
      unlisten.then((off) => off())
    }
  }, [active])

  async function check() {
    setChecking(true)
    setError(null)
    try {
      setStatus(await api.mailCheck())
    } catch (e) {
      setError(String(e))
    } finally {
      setChecking(false)
    }
  }

  return { status, error, busy: checking || !!status?.checking, check }
}
