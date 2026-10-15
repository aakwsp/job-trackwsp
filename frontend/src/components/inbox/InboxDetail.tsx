import { useState, type ReactNode } from 'react'
import * as api from '../../api'
import type { InboxDetail, RouteEdit } from '../../types'
import { eventColor, eventLabel, localDayTime } from '../../lib/inbox'
import { outlineButton, primaryButton } from '../record/parts'

// The open email (design/inbox/Inbox.dc.html, right column): // email,
// // extracted, // match, // actions. The body is plain text in a
// <blockquote> with `white-space: pre-line`: email HTML is never rendered
// (it was stripped to text when stored, and React escapes it anyway).

type Props = {
  detail: InboxDetail
  act: (fn: () => Promise<unknown>) => Promise<void>
}

const STAGE_NAME: Record<string, string> = {
  applied: 'applied',
  assessment: 'assessment',
  interview: 'interview',
  offer: 'offer',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
}

const TYPES = ['applied', 'assessment', 'interview', 'offer', 'rejection', 'follow_up', 'scheduling', 'job_alert', 'not_job']

/** Gemini's per-field confidence under this marks the field (pink square). */
const LOW_FIELD = 0.8

export default function InboxDetailPane({ detail, act }: Props) {
  const { email, extraction: x, match: m } = detail
  // Edit / change-match state remembers which email it belongs to, so
  // opening another email drops it without an effect to reset it.
  const [editingFor, setEditingFor] = useState<number | null>(null)
  const [edits, setEdits] = useState<RouteEdit>({})
  const [changingFor, setChangingFor] = useState<number | null>(null)
  const [pickApp, setPickApp] = useState<number | null>(null)
  const editing = editingFor === email.id
  const changing = changingFor === email.id

  const isChecking = email.status === 'checking' || email.status === 'extracted'
  const isDone = email.status === 'auto' || email.status === 'confirmed'
  const fieldConf: Record<string, number> = (() => {
    try {
      return JSON.parse(x?.field_confidence ?? '{}')
    } catch {
      return {}
    }
  })()

  // Done emails have touched the pipeline: changing them undoes first.
  const undoFirst = async () => {
    if (isDone) await api.routeUndo(email.id)
  }
  const saveEdits = async () => {
    const changed = Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined && v !== '')) as RouteEdit
    if (Object.keys(changed).length === 0) return
    await undoFirst()
    await api.routeEdit(email.id, changed)
  }
  const stopEditing = () => {
    setEditingFor(null)
    setEdits({})
  }

  const fields: { k: string; key: keyof RouteEdit; conf: string; v: string | null }[] = [
    { k: 'company', key: 'company', conf: 'company', v: x?.company ?? null },
    { k: 'role', key: 'role', conf: 'role', v: x?.role ?? null },
    { k: 'req id', key: 'req_id', conf: 'req_id', v: x?.req_id ?? null },
    { k: 'event type', key: 'event_type', conf: 'event_type', v: x?.event_type ?? null },
    { k: 'event date', key: 'event_date', conf: 'event_date', v: x?.occurred_at ?? null },
  ]

  const app = m?.application ?? null
  const writes = m?.action.startsWith('write_event:') ? m.action.slice('write_event:'.length) : null
  const effect = effectLine(email.status, detail, writes, editing)

  return (
    <>
      <Band first>// email</Band>
      <div className="px-8 pt-1.5">
        <dl className="m-0 grid grid-cols-[7.5rem_minmax(0,1fr)] text-meta leading-normal">
          <Dt first>from</Dt>
          <Dd first>{email.from_addr ?? ''}</Dd>
          <Dt>subject</Dt>
          <Dd>{email.subject ?? ''}</Dd>
          <Dt>received</Dt>
          <Dd>{localDayTime(email.received_at)}</Dd>
        </dl>
        <blockquote className="m-0 mt-2.5 max-h-[22rem] overflow-y-auto border border-rule bg-bg px-4 py-3.5 text-[0.71875rem] leading-[1.75] whitespace-pre-line text-text-muted">
          {email.body_text?.trim() || '(no text)'}
        </blockquote>
        <div className="mt-3.5">
          <button
            type="button"
            onClick={() => act(() => api.inboxOpenInGmail(email.id))}
            className="inline-flex h-9 cursor-pointer items-center border border-rule-strong px-3.5 text-[0.71875rem] text-text hover:border-text-muted hover:bg-bg-active"
          >
            [ open in gmail ↗ ]
          </button>
        </div>
      </div>

      <Band aside={editing ? 'editing · low-confidence fields outlined' : x?.confidence != null ? `confidence ${x.confidence.toFixed(2)}` : undefined}>
        // extracted
      </Band>
      <div className="px-8 pt-1.5">
        {!x ? (
          <p className="py-2 text-meta text-text-dim">{email.extract_error ? `not parsed: ${email.extract_error}` : 'waiting for gemini.'}</p>
        ) : (
          <dl className="m-0 grid grid-cols-[7.5rem_minmax(0,1fr)] text-meta leading-normal">
            {fields.map((f) => {
              const low = (fieldConf[f.conf] ?? 1) < LOW_FIELD
              const color = f.key === 'event_type' ? eventColor(f.v) : null
              return (
                <div key={f.k} className="contents">
                  <dt className="flex items-start gap-2 border-b border-rule py-2 text-text-muted">
                    <span>{f.k}</span>
                    {low && <span role="img" aria-label="low confidence" className="mt-[0.4375rem] block size-1.5 bg-pink" />}
                  </dt>
                  <dd className="m-0 min-w-0 border-b border-rule py-2">
                    {!editing ? (
                      <span
                        data-color={color ?? undefined}
                        className={!f.v ? 'text-text-dim' : color ? 'text-(--c)' : f.key === 'event_type' ? 'text-text-muted' : ''}
                      >
                        {f.key === 'event_type' ? eventLabel(f.v) : (f.v ?? '—')}
                      </span>
                    ) : f.key === 'event_type' ? (
                      <select
                        aria-label="event type"
                        value={edits.event_type ?? f.v ?? ''}
                        onChange={(e) => setEdits({ ...edits, event_type: e.target.value })}
                        className="h-8 w-full border border-rule-strong bg-bg px-2 text-meta text-text"
                      >
                        {TYPES.map((t) => (
                          <option key={t} value={t}>
                            {eventLabel(t)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          type="text"
                          aria-label={f.k}
                          value={(edits[f.key] as string | undefined) ?? f.v ?? ''}
                          placeholder={f.key === 'req_id' ? 'not in email' : ''}
                          onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}
                          className={`h-8 w-full border bg-bg px-2.5 text-meta text-text outline-none placeholder:text-text-dim ${
                            low ? 'border-text' : 'border-rule-strong'
                          }`}
                        />
                        {(low || (edits[f.key] !== undefined && edits[f.key] !== f.v)) && (
                          <span className="mt-1.5 block text-[0.65625rem] text-text-dim">
                            parsed: {f.v ?? '—'}
                            {low ? ' · low confidence' : ''}
                          </span>
                        )}
                      </>
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
        )}
      </div>

      <Band>// match</Band>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-8 pt-4">
        <div className="min-w-[16.25rem] flex-1 text-meta leading-[1.6]">
          {app ? (
            <>
              <span className="font-serif text-[1.0625rem] lowercase">{app.company}</span>
              <span className="text-text-dim"> · </span>
              <span className="text-text-muted lowercase">{app.title}</span>
              <span className="text-text-dim"> · </span>
              currently{' '}
              <span data-color={eventColor(app.status) ?? undefined} className={eventColor(app.status) ? 'text-(--c)' : 'text-text-muted'}>
                {STAGE_NAME[app.status] ?? app.status}
              </span>
            </>
          ) : m && m.candidates.length > 1 ? (
            <span className="text-text-muted">
              {m.candidates.length} applications could match: {m.candidates.map((c) => `${c.company.toLowerCase()} — ${c.title.toLowerCase()}`).join(' · ')}
            </span>
          ) : m?.suggested_job ? (
            <span className="text-text-muted">
              no application yet · posting: <span className="text-text lowercase">{m.suggested_job.company} — {m.suggested_job.title}</span>
            </span>
          ) : (
            <span className="text-text-dim">{m ? 'not in pipeline' : 'not matched yet'}</span>
          )}
        </div>
        {m && (
          <button
            type="button"
            onClick={() => {
              setChangingFor(changing ? null : email.id)
              setPickApp(app?.id ?? m.candidates[0]?.id ?? null)
            }}
            aria-pressed={changing}
            className={outlineButton}
          >
            [ change match ]
          </button>
        )}
      </div>
      {m && (
        <p className="px-8 pt-2 text-[0.65625rem] leading-[1.7] text-text-dim">
          score <span className={m.score < 0.8 ? 'text-pink' : 'text-text-muted'}>{m.score.toFixed(2)}</span>
          {m.reasons.filter((r) => !r.startsWith('llm 0') && !r.startsWith('llm 1')).map((r) => ` · ${r}`)}
          {m.note ? ` — ${m.note}` : ''}
        </p>
      )}
      {changing && m && (
        <div className="flex flex-wrap items-center gap-2 px-8 pt-3">
          <select
            aria-label="match to application"
            value={pickApp ?? ''}
            onChange={(e) => setPickApp(Number(e.target.value))}
            className="h-11 min-w-0 flex-1 border border-rule-strong bg-bg px-2 text-meta text-text"
          >
            {/* Candidates first, then every other application. */}
            {[...m.candidates, ...detail.applications.filter((a) => !m.candidates.some((c) => c.id === a.id))].map((a) => (
              <option key={a.id} value={a.id}>
                {a.company.toLowerCase()} — {a.title.toLowerCase()} ({a.status})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pickApp === null}
            onClick={() =>
              act(async () => {
                await undoFirst()
                await api.routeEdit(email.id, { application_id: pickApp! })
                setChangingFor(null)
              })
            }
            className={outlineButton}
          >
            [ use this ]
          </button>
        </div>
      )}

      <Band>// actions</Band>
      <div className="px-8 pt-4">
        <div className="flex flex-wrap gap-2">
          {isChecking && (
            <>
              <button
                type="button"
                onClick={() =>
                  act(async () => {
                    if (editing) await saveEdits()
                    // With no application but a suggested posting, confirm
                    // creates the application from it (the only way mail
                    // ever creates one).
                    const fromJob = !app && m?.suggested_job ? m.suggested_job.id : null
                    await api.routeConfirm(email.id, null, fromJob)
                    stopEditing()
                  })
                }
                disabled={!app && !m?.suggested_job}
                className={`${primaryButton} disabled:cursor-default disabled:opacity-40`}
              >
                {!app && m?.suggested_job ? '[ create application from posting ]' : '[ confirm ]'}
              </button>
              <EditButton editing={editing} onToggle={() => (editing ? act(saveEdits).then(stopEditing) : setEditingFor(email.id))} />
              <button type="button" onClick={() => act(() => api.routeReject(email.id))} className={outlineButton}>
                [ reject ]
              </button>
            </>
          )}
          {isDone && (
            <>
              <EditButton editing={editing} onToggle={() => (editing ? act(saveEdits).then(stopEditing) : setEditingFor(email.id))} />
              <button type="button" onClick={() => act(() => api.routeUndo(email.id))} className={outlineButton}>
                [ undo ]
              </button>
            </>
          )}
        </div>
        <p className="mt-3.5 text-[0.71875rem] leading-[1.6] text-text-muted">{effect}</p>
      </div>
      <p className="px-8 pt-[1.625rem] pb-7 text-micro leading-[1.8] text-text-dim">
        j/k next/prev · ←/→ along timeline · c confirm · e edit · x reject · m read/unread · g by email/by job · esc close
      </p>
    </>
  )
}

function EditButton({ editing, onToggle }: { editing: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={editing} className={outlineButton}>
      {editing ? '[ done editing ]' : '[ edit ]'}
    </button>
  )
}

/** The board's one-line "what this does / did" under the actions. */
function effectLine(status: string, d: InboxDetail, writes: string | null, editing: boolean): string {
  const m = d.match
  const app = m?.application
  const co = app?.company.toLowerCase() ?? ''
  const stageNow = app ? (STAGE_NAME[app.status] ?? app.status) : '—'
  if (status === 'pending') return d.email.extract_error ? `waiting to be parsed again: ${d.email.extract_error}` : 'waiting for gemini to parse it.'
  if (status === 'rejected') return 'rejected by you: kept here, not in the pipeline.'
  if (status === 'checking' || status === 'extracted') {
    if (!app) {
      if (m?.suggested_job) return 'no application yet: this creates one from the suggested posting, then applies the email to it.'
      return 'pick an application with [ change match ] to confirm.'
    }
    let line = writes
      ? `confirming moves ${co} from ${stageNow} → ${STAGE_NAME[writes] ?? writes} and adds it to the timeline.`
      : `confirming adds it to ${co}’s timeline; stage stays ${stageNow}.`
    if (editing) line = line.replace('confirming', 'confirming saves your corrections and')
    return line
  }
  const how = status === 'auto' ? `auto-confirmed ${m ? m.score.toFixed(2) : ''}: ` : 'confirmed by you: '
  const undoNote = editing ? ' saving edits undoes this first and puts it back in checking.' : ''
  if (!m || !app) return how + 'not matched.' + undoNote
  if (m.wrote_event && writes === 'rejected') return `${how}${co} moved to rejected and closed.${undoNote}`
  if (m.wrote_event && writes) return `${how}${co} moved to ${STAGE_NAME[writes] ?? writes}.${undoNote}`
  return `${how}added to ${co}’s timeline; stage unchanged.${undoNote}`
}

// Detail-pane `// section` band: 36px, hairlines, padding 0 32px.
function Band({ children, aside, first = false }: { children: ReactNode; aside?: string; first?: boolean }) {
  return (
    <div
      className={`flex h-9 shrink-0 items-center border-b border-rule bg-bg px-8 text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase ${
        first ? '' : 'mt-6 border-t'
      }`}
    >
      <h2 className="font-mono">{children}</h2>
      {aside && <span className="ml-auto text-micro tracking-[0.02em] text-text-dim normal-case">{aside}</span>}
    </div>
  )
}

function Dt({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return <dt className={`py-2 text-text-muted ${first ? '' : 'border-t border-rule'}`}>{children}</dt>
}

function Dd({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return <dd className={`m-0 min-w-0 py-2 [overflow-wrap:anywhere] ${first ? '' : 'border-t border-rule'}`}>{children}</dd>
}

