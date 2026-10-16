import { useEffect, useState } from 'react'
import * as api from '../../api'
import type { InboxDetail, TimelineNode } from '../../types'
import { localDayTime } from '../../lib/inbox'
import Timeline from '../Timeline'
import { Details, Row, ghostButton, type Pad } from './parts'

// The shared timeline as the record shows it (JT-41): clicking an email
// diamond opens that email inline under the track (from, subject, date,
// plain-text body), with [ open in inbox → ] under it. The same diamond
// again, or esc, closes it; one email at a time, and the open diamond is
// drawn selected. INBOX keeps the plain Timeline, where a diamond selects
// the email in the detail pane instead.
//
// The body is plain text in a <blockquote> with `white-space: pre-line`:
// email HTML is never rendered (it was stripped to text when stored, and
// React escapes text anyway).

type Props = {
  nodes: TimelineNode[]
  pad: Pad
  onOpenInInbox: (emailId: number) => void
}

type Loaded = { id: number; detail: InboxDetail | null } | { id: number; error: string }

export default function RecordTimeline({ nodes, pad, onOpenInInbox }: Props) {
  const [openId, setOpenId] = useState<number | null>(null)
  // What was fetched, tagged with its id: a stale answer for an email
  // that's no longer open is simply not shown.
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const shown = loaded && loaded.id === openId ? loaded : null

  useEffect(() => {
    if (openId === null) return
    let stale = false
    // inbox_detail only reads; opening it here doesn't mark it read.
    api
      .inboxDetail(openId)
      .then((detail) => !stale && setLoaded({ id: openId, detail }))
      .catch((e) => !stale && setLoaded({ id: openId, error: String(e) }))
    return () => {
      stale = true
    }
  }, [openId])

  // esc closes the email before anything else sees it (the record closes
  // on esc too). A capture listener on `window` runs before the record's
  // listener on `document`, and stopPropagation keeps it from getting
  // there. Only registered while an email is open, so esc otherwise
  // behaves as before.
  useEffect(() => {
    if (openId === null) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpenId(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [openId])

  const email = shown && 'detail' in shown ? shown.detail?.email : null

  return (
    <>
      <Timeline nodes={nodes} large currentId={openId} onPick={(id) => setOpenId((cur) => (cur === id ? null : id))} />
      {openId !== null && (
        <div className={`border-t border-rule pt-1.5 pb-2 ${pad}`}>
          {!shown ? (
            <p className="py-2 text-meta text-text-dim">loading…</p>
          ) : 'error' in shown ? (
            <p className="py-2 text-meta text-text-dim">could not load this email: {shown.error}</p>
          ) : !email ? (
            <p className="py-2 text-meta text-text-dim">this email is no longer stored.</p>
          ) : (
            <>
              <Details>
                <Row label="from" first>
                  <span className="[overflow-wrap:anywhere]">{email.from_addr ?? ''}</span>
                </Row>
                <Row label="subject">
                  <span className="[overflow-wrap:anywhere]">{email.subject ?? ''}</span>
                </Row>
                <Row label="received">{localDayTime(email.received_at)}</Row>
              </Details>
              <blockquote className="m-0 mt-2.5 max-h-[22rem] overflow-y-auto border border-rule bg-bg px-4 py-3.5 text-[0.71875rem] leading-[1.75] whitespace-pre-line text-text-muted">
                {email.body_text?.trim() || '(no text)'}
              </blockquote>
            </>
          )}
          <div className="mt-2 flex items-center gap-4">
            <button type="button" onClick={() => onOpenInInbox(openId)} className={ghostButton}>
              [ open in inbox → ]
            </button>
            <span className="text-micro text-text-dim">◆ again or esc closes</span>
          </div>
        </div>
      )}
    </>
  )
}
