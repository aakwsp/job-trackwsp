// The record's four tabs, in order; keys 1–4 pick them by position.
export const TABS = ['summary', 'posting', 'application', 'emails'] as const
// `(typeof TABS)[number]`: the union of the array's values,
// 'summary' | 'posting' | 'application' | 'emails'. `as const` above is what
// keeps them as literal strings rather than widening to `string`.
export type Tab = (typeof TABS)[number]

// Which view opened the record; shown as "from jobs" and in the breadcrumb.
export type RecordFrom = 'jobs' | 'pipeline'
