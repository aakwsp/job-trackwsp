import type { InboxRow, StatusColor } from '../types'

// Display rules from design/inbox/*.dc.html.

/** The stage colour an event type is shown in; null = muted. */
export function eventColor(type: string | null): StatusColor | null {
  switch (type) {
    case 'applied':
      return 'sand'
    case 'assessment':
      return 'blue'
    case 'interview':
      return 'pink'
    case 'offer':
      return 'green'
    default:
      return null // rejection, follow-up, scheduling, not parsed yet
  }
}

/** "follow_up" → "follow-up", as the boards write it. */
export function eventLabel(type: string | null): string {
  return type ? type.replace('_', '-') : 'waiting'
}

/** Scores under this are shown pink. */
export const LOW_SCORE = 0.8

export type MailSort = 'newest' | 'company' | 'score'

export function sortRows(rows: InboxRow[], sort: MailSort): InboxRow[] {
  const a = [...rows]
  const recv = (r: InboxRow) => r.received_at ?? ''
  if (sort === 'company')
    a.sort((x, y) => (x.company ?? '').localeCompare(y.company ?? '') || recv(y).localeCompare(recv(x)))
  // Lowest score first: the ones most worth a look. Unscored at the end.
  else if (sort === 'score') a.sort((x, y) => (x.score ?? 2) - (y.score ?? 2))
  else a.sort((x, y) => recv(y).localeCompare(recv(x)))
  return a
}

/** 'YYYY-MM-DD' of a stored UTC timestamp, in local time. */
export function localDay(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 'YYYY-MM-DD HH:MM' local. */
export function localDayTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${localDay(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
