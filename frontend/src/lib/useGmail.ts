import { useEffect, useState } from 'react'
import * as api from '../api'

// The job account's connection, for the QUEUE page (JT-13). A custom hook:
// App calls it once and passes the pieces to the hero and
// the page body, which both show part of it.
export type GmailStatus = { kind: 'checking' } | { kind: 'disconnected' } | { kind: 'connected'; address: string }

export function useGmail(active: boolean) {
  const [status, setStatus] = useState<GmailStatus>({ kind: 'checking' })
  // True while the browser sign-in is open (gmail_connect can take minutes).
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ask Rust every time the page is opened. It checks with Google (through
  // a cached access token), so a revoked or expired login shows as
  // disconnected here rather than failing later.
  useEffect(() => {
    if (!active) return
    let stale = false
    api
      .gmailStatus()
      .then((address) => !stale && setStatus(address ? { kind: 'connected', address } : { kind: 'disconnected' }))
      .catch((e) => {
        if (stale) return
        setStatus({ kind: 'disconnected' })
        setError(String(e))
      })
    return () => {
      stale = true
    }
  }, [active])

  async function connect() {
    setBusy(true)
    setError(null)
    try {
      const address = await api.gmailConnect()
      setStatus({ kind: 'connected', address })
    } catch (e) {
      // Cancelling is a choice, not a failure: no error line for it.
      if (String(e) !== 'cancelled') setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  // [ cancel ] while signing in. The pending `connect` above then rejects
  // with "cancelled" and clears `busy` itself.
  function cancel() {
    api.gmailCancel().catch((e) => setError(String(e)))
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    try {
      await api.gmailDisconnect()
      setStatus({ kind: 'disconnected' })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return { status, busy, error, connect, cancel, disconnect }
}
