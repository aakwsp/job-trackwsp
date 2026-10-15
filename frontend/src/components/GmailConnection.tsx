import type { GmailStatus } from '../lib/useGmail'
import type { MailStatus } from '../types'
import { primaryButton } from './record/parts'

// The job account's connection status, from design/inbox/InboxDisconnected
// (JT-13). Only these two pieces; the rest of that board is JT-18.

type Props = {
  status: GmailStatus
  busy: boolean
  error: string | null
  onConnect: () => void
  onCancel: () => void
  onDisconnect: () => void
}

// "last checked 09:42 · 3 new" (JT-14), from the board's connected state:
// values in the text colour, the separator dim.
export function MailStatusLine({ mail, busy }: { mail: MailStatus | null; busy: boolean }) {
  if (busy) return <>checking mail…</>
  if (!mail?.last_checked_at) return <>not checked yet</>
  return (
    <>
      last checked <span className="text-text">{hhmm(mail.last_checked_at)}</span>
      <span className="text-text-dim"> · </span>
      <span className="text-text">{mail.last_new}</span> new
    </>
  )
}

// Local 24-hour time. `toLocaleTimeString` with explicit options, so it's
// "09:42" rather than whatever the locale's default (with seconds, AM/PM)
// would be.
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

// [ check mail ] at the hero's right edge, as on the board: 36px, outlined.
export function CheckMailButton({ busy, onCheck }: { busy: boolean; onCheck: () => void }) {
  return (
    <button
      type="button"
      onClick={onCheck}
      disabled={busy}
      className="inline-flex h-9 shrink-0 cursor-pointer items-center border border-rule-strong px-3.5 text-[0.71875rem] text-text hover:border-text-muted hover:bg-bg-hover disabled:cursor-wait disabled:opacity-50"
    >
      {busy ? '[ checking… ]' : '[ check mail ]'}
    </button>
  )
}

// The hero's status line (where the subtitle goes). Disconnected:
// "gmail not connected · nothing new is being checked". Connected:
// "connected as <address>  [ disconnect ]", under the mail status line.
export function GmailStatusLine({ status, busy, onDisconnect }: Props) {
  if (status.kind === 'checking') return <>checking gmail…</>
  if (status.kind === 'disconnected')
    return (
      <>
        <span className="text-pink">gmail not connected</span>
        <span className="text-text-dim"> · </span>nothing new is being checked
      </>
    )
  return (
    <>
      connected as <span className="text-text">{status.address}</span>
      <button
        type="button"
        onClick={onDisconnect}
        disabled={busy}
        className="ml-4 cursor-pointer hover:text-text disabled:cursor-wait disabled:opacity-50"
      >
        [ disconnect ]
      </button>
    </>
  )
}

// The block under the hero, shown only while disconnected. Errors (no
// client file, no keyring, timed out, ...) show under the button; while
// connected they go under the status line instead (see App).
export function GmailConnectBlock({ status, busy, error, onConnect, onCancel }: Props) {
  if (status.kind !== 'disconnected') return null
  return (
    <div className="border-b border-rule pt-6 pr-5 pb-[1.625rem] pl-6">
      <p className="font-serif text-[1.375rem] leading-[1.1] text-text-dim">gmail not connected.</p>
      <p className="mt-2 text-[0.65625rem] leading-[1.7] text-text-dim">
        parsed mail below is kept. connect your job account to keep it current.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          className={`${primaryButton} disabled:cursor-wait disabled:opacity-60`}
        >
          {busy ? '[ finish signing in, in your browser… ]' : '[ connect job account ]'}
        </button>
        {/* Closed the tab, or changed your mind: stop waiting now rather
            than at the 5-minute timeout. */}
        {busy && (
          <button type="button" onClick={onCancel} className="cursor-pointer text-meta text-text-muted hover:text-text">
            [ cancel ]
          </button>
        )}
      </div>
      {error && <p className="mt-3 max-w-xl text-[0.65625rem] leading-[1.7] text-pink">{error}</p>}
    </div>
  )
}
