// The app's three top-level views. No router library: the active page is a
// piece of state in App, and switching is just setting it. Nothing here
// needs URLs (it's a desktop app with one window).
export type Page = 'jobs' | 'queue' | 'pipeline'

// Tab label, hero title and the one-line subtitle under it. Queue and
// pipeline copy is placeholder until those views exist.
export const PAGES: { page: Page; tab: string; title: string; subtitle: string }[] = [
  {
    page: 'jobs',
    tab: 'jobs',
    title: 'job postings',
    subtitle:
      'curated co-ops and software engineering placements. tracking application status, locations, and deadlines across active recruitment cycles.',
  },
  {
    page: 'queue',
    tab: 'queue',
    title: 'queue',
    subtitle: 'postings lined up to apply to next, in the order you plan to send them.',
  },
  {
    page: 'pipeline',
    tab: 'pipeline',
    title: 'pipeline',
    subtitle: 'applications in flight, from submitted through assessments and interviews to an answer.',
  },
]
