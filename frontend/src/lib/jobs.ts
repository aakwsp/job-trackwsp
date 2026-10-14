import type { Filters, Job, RowStatus } from '../types'

export const CLOSING_DAYS = 7

export const EMPTY_FILTERS: Filters = {
  query: '',
  city: '',
  source: '',
  unappliedOnly: false,
  closingOnly: false,
  hideBorderline: false,
}

// 'YYYY-MM-DD' → whole days since the epoch. Going through Date.UTC (not
// `new Date('2026-10-14')` minus `new Date()`) keeps time zones and DST out
// of the subtraction.
function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

function todayYmd(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Days from today (local) until the deadline; negative once it has passed. */
export function daysLeft(deadline: string | null): number | null {
  if (!deadline) return null
  const days = dayNumber(deadline) - dayNumber(todayYmd())
  return Number.isNaN(days) ? null : days
}

export function isClosingSoon(job: Job): boolean {
  const days = daysLeft(job.deadline)
  return days !== null && days >= 0 && days <= CLOSING_DAYS
}

// Only one edge colour fits, so: applied beats closing beats borderline.
export function rowStatus(job: Job): RowStatus {
  if (job.applied) return 'applied'
  if (isClosingSoon(job)) return 'closing'
  if (job.borderline) return 'borderline'
  return 'none'
}

export function matchesFilters(job: Job, f: Filters): boolean {
  const q = f.query.trim().toLowerCase()
  if (q && !`${job.company} ${job.title}`.toLowerCase().includes(q)) return false
  if (f.city && job.city !== f.city) return false
  if (f.source && job.source !== f.source) return false
  if (f.unappliedOnly && job.applied) return false
  if (f.closingOnly && !isClosingSoon(job)) return false
  if (f.hideBorderline && job.borderline) return false
  return true
}

export type CityGroup = { city: string; jobs: Job[] }

export const NO_CITY = 'unknown'

/**
 * Buckets jobs by city, keeping the incoming (deadline, last_seen) order
 * inside each bucket. Biggest cities first so toronto leads, ties by name.
 */
export function groupByCity(jobs: Job[]): CityGroup[] {
  const map = new Map<string, Job[]>()
  for (const job of jobs) {
    const city = job.city ?? NO_CITY
    const bucket = map.get(city)
    if (bucket) bucket.push(job)
    else map.set(city, [job])
  }
  return [...map]
    .map(([city, jobs]) => ({ city, jobs }))
    .sort((a, b) => b.jobs.length - a.jobs.length || a.city.localeCompare(b.city))
}

/** Sorted distinct non-null values of one field, for the filter selects. */
export function distinct(jobs: Job[], key: 'city' | 'source'): string[] {
  const values = new Set<string>()
  for (const job of jobs) {
    const v = job[key]
    if (v) values.add(v)
  }
  return [...values].sort((a, b) => a.localeCompare(b))
}
