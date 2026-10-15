// The record's four tabs, in order; keys 0–3 pick them by position.
export const TABS = ['summary', 'posting', 'application', 'emails'] as const
// `(typeof TABS)[number]`: the union of the array's values,
// 'summary' | 'posting' | 'application' | 'emails'. `as const` above is what
// keeps them as literal strings rather than widening to `string`.
export type Tab = (typeof TABS)[number]

/** The tab a key press picks ('0' → summary, ...), or null. Compares the
 *  key as text: `Number(' ')` is 0, so a numeric check would make Space
 *  jump to summary. */
export function tabForKey(key: string): Tab | null {
  const i = TABS.findIndex((_, i) => String(i) === key)
  return i === -1 ? null : TABS[i]
}

// Which view opened the record; shown as "from jobs" and in the breadcrumb.
export type RecordFrom = 'jobs' | 'pipeline'
