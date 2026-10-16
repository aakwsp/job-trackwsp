import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStuck } from '../../lib/useStuck'
import type { Notify } from '../../lib/useInbox'
import * as api from '../../api'
import type { AppRef, InboxDetail, NewJob, RouteEdit } from '../../types'
import { eventColor, eventLabel, localDay, localDayTime } from '../../lib/inbox'
import { outlineButton, primaryButton } from '../record/parts'
import Timeline from '../Timeline'
import Select from '../Select'

// The open email, top to bottom (JT-41): // email (+ [ open in gmail ]),
// // extracted, // match, // actions, then // timeline at the bottom.
// Only the company · role line stays pinned while it scrolls. The body is plain text in a
// <blockquote> with `white-space: pre-line`: email HTML is never rendered
// (it was stripped to text when stored, and React escapes it anyway).

type Props = {
  detail: InboxDetail
  act: (fn: () => Promise<unknown>) => Promise<boolean>
  notify: Notify
  // Confirmed / rejected: the list moves on to the next checking email.
  onResolved: (emailId: number, status: 'confirmed' | 'rejected') => void
  // By-job view: the larger timeline with labels.
  large: boolean
  onOpenEmail: (emailId: number) => void
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

export default function InboxDetailPane({ detail, act, notify, onResolved, large, onOpenEmail }: Props) {
  const { email, extraction: x, match: m } = detail
  // Edit / change-match state remembers which email it belongs to, so
  // opening another email drops it without an effect to reset it.
  const [editingFor, setEditingFor] = useState<number | null>(null)
  const [edits, setEdits] = useState<RouteEdit>({})
  const editing = editingFor === email.id

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
  // The rows under // match: routing's candidates, the matched one, then
  // every other application at the same company (so the right one is
  // there even when routing missed it).
  // The rows under // match. Quick picks: applications at the extracted
  // company (or the one typed in edit mode, so fixing the company refreshes
  // them). Then whatever the "// other application" search finds, across
  // all companies.
  const quickCompany = editing && edits.company ? edits.company : (x?.company ?? null)
  const quick = quickPicks(detail, quickCompany, !(editing && edits.company))
  // Search text and the new-job form belong to one email, like editingFor.
  const [other, setOther] = useState<{ id: number; q: string } | null>(null)
  const otherQ = other?.id === email.id ? other.q : ''
  const others = otherQ.trim() ? searchApps(detail.applications, otherQ, quick) : []
  const pickable = [...quick, ...others]
  const canPick = isChecking || isDone
  const [newJobFor, setNewJobFor] = useState<{ id: number; v: NewJob } | null>(null)
  const newJob = newJobFor?.id === email.id ? newJobFor.v : null
  // Prefilled from what Gemini extracted (and any edits); all editable.
  const startNewJob = () =>
    setNewJobFor({
      id: email.id,
      v: {
        company: edits.company ?? x?.company ?? '',
        title: edits.role ?? x?.role ?? '',
        city: '',
        req_id: edits.req_id ?? x?.req_id ?? '',
        url: '',
      },
    })
  const saveNewJob = async () => {
    const id = email.id
    const v = newJob!
    const ok = await act(async () => {
      await undoFirst()
      await api.routeNewJob(id, v)
      setNewJobFor(null)
    })
    if (!ok) return
    onResolved(id, 'confirmed')
    notify({ text: `new job: ${v.company.toLowerCase()} · ${v.title.toLowerCase()}`, onUndo: () => act(() => api.routeUndo(id)) })
  }
  // Matches the email to another application right away: undoes an
  // applied email first (it goes back to checking), then re-routes it.
  // The detail reloads straight after (act), so the score, reasons and
  // effect line follow at once.
  const assign = (id: number) =>
    act(async () => {
      await undoFirst()
      await api.routeEdit(email.id, { application_id: id })
    })
  const writes = m?.action.startsWith('write_event:') ? m.action.slice('write_event:'.length) : null
  const effect = effectLine(email.status, detail, writes, editing)
  const emailCount = detail.timeline.filter((n) => n.kind === 'email').length

  // The actions, shared by the buttons and the keys.
  const canConfirm = isChecking && (!!app || !!m?.suggested_job)
  // "google · applied" for the bottom line.
  const what = `${(app?.company ?? x?.company ?? '').toLowerCase()} · ${eventLabel(edits.event_type ?? x?.event_type ?? null)}`
  const confirm = async () => {
    const id = email.id
    const ok = await act(async () => {
      if (editing) await saveEdits()
      // The matched application (routing's, or the one picked with
      // [ change match ]). With none but a suggested posting, confirm
      // creates the application from it (the only way mail creates one).
      const fromJob = !app && m?.suggested_job ? m.suggested_job.id : null
      await api.routeConfirm(id, app?.id ?? null, fromJob)
      stopEditing()
    })
    if (!ok) return
    onResolved(id, 'confirmed')
    notify({ text: `confirmed: ${what}`, onUndo: () => act(() => api.routeUndo(id)) })
  }
  const reject = async () => {
    const id = email.id
    if (!(await act(() => api.routeReject(id)))) return
    onResolved(id, 'rejected')
    notify({ text: `rejected: ${what}`, onUndo: () => act(() => api.routeUnreject(id)) })
  }
  const toggleEdit = () => (editing ? act(saveEdits).then(stopEditing) : setEditingFor(email.id))

  // c / Enter confirm · 1–9 match · e edit · x reject · esc leaves
  // editing. Through a ref, like the list's keys, so the handler sees this
  // render.
  const keys = useRef({ canConfirm, isChecking, isDone, confirm, reject, toggleEdit, editing, pickable, canPick, app, assign })
  useEffect(() => {
    keys.current = { canConfirm, isChecking, isDone, confirm, reject, toggleEdit, editing, pickable, canPick, app, assign }
  })
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const k = keys.current
      if (e.key === 'Escape') {
        if (!k.editing) return
        setEditingFor(null)
        setEdits({})
      } else if (e.target instanceof Element && e.target.closest('input, textarea, select')) {
        return
      } else if ((e.key === 'c' || (e.key === 'Enter' && !(e.target instanceof Element && e.target.closest('button')))) && k.canConfirm)
        // Enter on a focused button already clicks it; don't also confirm.
        k.confirm()
      else if (/^[1-9]$/.test(e.key) && (k.isChecking || k.isDone)) {
        const a = k.pickable[Number(e.key) - 1]
        if (!a || !k.canPick) return
        if (a.id !== k.app?.id) k.assign(a.id)
      }
      else if (e.key === 'e' && (k.isChecking || k.isDone)) k.toggleEdit()
      else if (e.key === 'x' && k.isChecking) k.reject()
      else return
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <Pinned>
        {/* company · role, pinned while the rest scrolls. */}
        <p className="truncate px-8 pt-3 pb-2.5 text-meta leading-normal">
          <span className="font-serif text-[1.0625rem] lowercase">{(app?.company ?? x?.company ?? email.from_addr ?? '').toLowerCase()}</span>
          {(app?.title ?? x?.role) && (
            <>
              <span className="text-text-dim"> · </span>
              <span className="text-text-muted lowercase">{app?.title ?? x?.role}</span>
            </>
          )}
        </p>
      </Pinned>
      <Band flush>// email</Band>
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
                      <Select
                        label="event type"
                        value={edits.event_type ?? f.v ?? ''}
                        onChange={(v) => setEdits({ ...edits, event_type: v })}
                        className="h-8 w-full"
                      >
                        {TYPES.map((t) => (
                          <option key={t} value={t}>
                            {eventLabel(t)}
                          </option>
                        ))}
                      </Select>
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

      <Band aside={canPick ? (isChecking ? '1–9 or click to match · c confirms' : '1–9 or click to re-match') : undefined}>
        // match
      </Band>
      {/* Applications as rows: the matched one is outlined; clicking a row
          (or pressing its number) matches the email to it at once. One
          radiogroup over the quick picks and the search results, since
          exactly one can be the match; the numbers run across both. */}
      <div role="radiogroup" aria-label="match to application" className="px-8 pt-3">
        {quick.map((a, i) => (
          <MatchRow key={a.id} a={a} n={i + 1} on={a.id === app?.id} onPick={canPick ? () => assign(a.id) : undefined} />
        ))}
        {quick.length === 0 && (
          <p className="py-2 text-meta text-text-dim">
            no application at {(quickCompany ?? 'this company').toLowerCase()}
            {m?.suggested_job && (
              <>
                {' '}
                · posting: <span className="text-text-muted lowercase">{m.suggested_job.company} — {m.suggested_job.title}</span>
              </>
            )}
          </p>
        )}
        {canPick && (
          <div className="mt-2 flex h-9 items-center gap-3 border-b border-rule">
            <label htmlFor="other-application" className="shrink-0 text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase">
              // other application
            </label>
            <input
              id="other-application"
              type="text"
              value={otherQ}
              onChange={(e) => setOther({ id: email.id, q: e.target.value })}
              onKeyDown={(e) => {
                // esc leaves the field (so 1–9 pick again), clearing it
                // first if there's text. Handled here, nothing else reacts.
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  if (otherQ) setOther(null)
                  else e.currentTarget.blur()
                }
              }}
              placeholder="any company or role"
              autoComplete="off"
              spellCheck={false}
              className="h-6 min-w-0 flex-1 appearance-none border-0 border-b border-rule-strong bg-transparent px-0 text-meta text-text outline-none placeholder:text-text-dim focus:border-text"
            />
            <span className="shrink-0 text-micro text-text-dim">{otherQ.trim() ? `${others.length} found` : 'all companies'}</span>
          </div>
        )}
        {others.map((a, i) => (
          <MatchRow key={a.id} a={a} n={quick.length + i + 1} on={a.id === app?.id} onPick={() => assign(a.id)} />
        ))}
      </div>
      {canPick && (
        <div className="px-8 pt-3">
          {newJob === null ? (
            <button type="button" onClick={startNewJob} className={outlineButton}>
              [ + new job ]
            </button>
          ) : (
            <NewJobForm value={newJob} onChange={(v) => setNewJobFor({ id: email.id, v })} onSave={saveNewJob} onCancel={() => setNewJobFor(null)} />
          )}
        </div>
      )}
      {m && (
        <p className="px-8 pt-1 text-[0.65625rem] leading-[1.7] text-text-dim">
          score <span className={m.score < 0.8 ? 'text-pink' : 'text-text-muted'}>{m.score.toFixed(2)}</span>
          {m.reasons.filter((r) => !r.startsWith('llm 0') && !r.startsWith('llm 1')).map((r) => ` · ${r}`)}
          {m.note ? ` — ${m.note}` : ''}
        </p>
      )}

      <Band>// actions</Band>
      <div className="px-8 pt-4">
        <div className="flex flex-wrap gap-2">
          {isChecking && (
            <>
              <button
                type="button"
                onClick={confirm}
                disabled={!canConfirm}
                // Disabled: a dim outline on the dark surface, not a faded
                // parchment block (pale text on a light box).
                className={`${primaryButton} disabled:cursor-default disabled:border-rule-strong disabled:bg-transparent disabled:font-normal disabled:text-text-dim disabled:hover:opacity-100`}
              >
                {!app && m?.suggested_job ? '[ create application from posting ]' : '[ confirm ]'}
              </button>
              <EditButton editing={editing} onToggle={toggleEdit} />
              <button type="button" onClick={reject} className={outlineButton}>
                [ reject ]
              </button>
            </>
          )}
          {isDone && (
            <>
              <EditButton editing={editing} onToggle={toggleEdit} />
              <button type="button" onClick={() => act(() => api.routeUndo(email.id))} className={outlineButton}>
                [ undo ]
              </button>
            </>
          )}
        </div>
        <p className="mt-3.5 text-[0.71875rem] leading-[1.6] text-text-muted">{effect}</p>
      </div>

      {/* Last: this application's other mail. A diamond opens that email
          here; ←/→ walk it. */}
      {detail.timeline.length > 0 && (
        <>
          <Band aside={`${(app?.company ?? '').toLowerCase()} · ${emailCount} ${emailCount === 1 ? 'email' : 'emails'}`}>// timeline</Band>
          <Timeline nodes={detail.timeline} currentId={email.id} large={large} onPick={onOpenEmail} />
        </>
      )}
      <p className="px-8 pt-[1.625rem] pb-7 text-micro leading-[1.8] text-text-dim">
        j/k next/prev · ←/→ along timeline · 1–9 match · c / enter confirm · e edit · x reject · m read/unread · g newest/company · esc stop editing
      </p>
    </>
  )
}

// The top of the detail pane that stays put while the rest scrolls: same
// surface as the pane, a hairline under it only while it's stuck.
function Pinned({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useStuck(ref)
  return (
    <div ref={ref} className={`sticky top-[-1px] z-10 shrink-0 border-b bg-bg ${stuck ? 'border-rule' : 'border-transparent'}`}>
      {children}
    </div>
  )
}

/** Company key for "same company": lowercase, letters and digits only. */
function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// The quick picks: the matched application and routing's candidates
// (unless the company was just edited), then every application at
// `company`.
function quickPicks(d: InboxDetail, company: string | null, withCandidates: boolean): AppRef[] {
  const m = d.match
  const out: AppRef[] = []
  const add = (a: AppRef | null | undefined) => a && !out.some((o) => o.id === a.id) && out.push(a)
  add(m?.application)
  if (withCandidates) m?.candidates.forEach(add)
  const co = norm(company)
  if (co) d.applications.filter((a) => norm(a.company) === co).forEach(add)
  return out
}

// "// other application": every word of the query somewhere in company,
// role or city; the quick picks aren't repeated.
function searchApps(all: AppRef[], q: string, skip: AppRef[]): AppRef[] {
  const words = norm(q).split(' ').filter(Boolean)
  return all.filter((a) => {
    if (skip.some((s) => s.id === a.id)) return false
    const hay = norm(`${a.company} ${a.title} ${a.city ?? ''}`)
    return words.every((w) => hay.includes(w))
  })
}

// One application row under // match: `company: role - city`, stage,
// applied date. Without onPick (nothing to change) it's just shown.
function MatchRow({ a, n, on, onPick }: { a: AppRef; n: number; on: boolean; onPick?: () => void }) {
  const c = eventColor(a.status)
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={!onPick}
      onClick={() => !on && onPick?.()}
      className={`grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] items-baseline gap-x-3 border px-3 py-2 text-left text-meta leading-normal ${
        on ? 'border-text bg-bg-active' : 'border-transparent border-b-rule enabled:cursor-pointer enabled:hover:border-rule-strong enabled:hover:bg-bg-active'
      }`}
    >
      <span className={on ? 'text-text' : 'text-text-dim'}>{n <= 9 ? n : ''}</span>
      <span className="truncate">
        <span className="lowercase">{a.company}</span>
        <span className="text-text-dim">: </span>
        <span className="text-text-muted">{a.title}</span>
        {a.city && <span className="text-text-dim"> - {a.city}</span>}
      </span>
      <span data-color={c ?? undefined} className={c ? 'text-(--c)' : 'text-text-muted'}>
        {STAGE_NAME[a.status] ?? a.status}
      </span>
      <span className="text-text-dim">{a.applied_at ? localDay(a.applied_at) : '—'}</span>
    </button>
  )
}

// [ + new job ]: the inline form, styled like the // extracted edit fields.
// Company and role are required; the rest optional.
function NewJobForm({ value, onChange, onSave, onCancel }: { value: NewJob; onChange: (v: NewJob) => void; onSave: () => void; onCancel: () => void }) {
  const fields: { k: keyof NewJob; label: string; ph: string }[] = [
    { k: 'company', label: 'company', ph: 'required' },
    { k: 'title', label: 'role', ph: 'required' },
    // Free text; may name several ("Waterloo or Toronto"). Splitting
    // those into cities is JT-38.
    { k: 'city', label: 'city', ph: 'optional, e.g. waterloo or toronto' },
    { k: 'req_id', label: 'req id', ph: 'optional' },
    { k: 'url', label: 'url', ph: 'optional, https://…' },
  ]
  const ready = value.company.trim() !== '' && value.title.trim() !== ''
  return (
    // A real <form>: Enter in any field saves (onSubmit), for free.
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSave()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        }
      }}
      className="border border-rule-strong px-4 pt-1 pb-4"
    >
      <p className="pt-2.5 pb-1 text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase">// new job</p>
      <dl className="m-0 grid grid-cols-[7.5rem_minmax(0,1fr)] text-meta leading-normal">
        {fields.map((f) => (
          <div key={f.k} className="contents">
            <dt className="border-b border-rule py-2 text-text-muted">
              <label htmlFor={`new-job-${f.k}`}>{f.label}</label>
            </dt>
            <dd className="m-0 min-w-0 border-b border-rule py-2">
              <input
                id={`new-job-${f.k}`}
                type="text"
                value={value[f.k] ?? ''}
                placeholder={f.ph}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => onChange({ ...value, [f.k]: e.target.value })}
                className="h-8 w-full border border-rule-strong bg-bg px-2.5 text-meta text-text outline-none placeholder:text-text-dim focus:border-text"
              />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[0.65625rem] leading-[1.6] text-text-dim">
        saving adds a manual posting to jobs, an application on it dated from this email, and confirms the email to it. u undoes all three.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={!ready}
          className={`${primaryButton} disabled:cursor-default disabled:border-rule-strong disabled:bg-transparent disabled:font-normal disabled:text-text-dim disabled:hover:opacity-100`}
        >
          [ save ]
        </button>
        <button type="button" onClick={onCancel} className={outlineButton}>
          [ cancel ]
        </button>
      </div>
    </form>
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
      return 'pick the application above (1–9) to confirm.'
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
// `flush`: hairline above but no gap (right under the timeline track).
function Band({ children, aside, first = false, flush = false }: { children: ReactNode; aside?: string; first?: boolean; flush?: boolean }) {
  return (
    <div
      className={`flex h-9 shrink-0 items-center border-b border-rule bg-bg px-8 text-[0.65625rem] tracking-[0.12em] text-text-muted uppercase ${
        first ? '' : flush ? 'border-t' : 'mt-6 border-t'
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

