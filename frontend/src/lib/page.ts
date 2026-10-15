// The app's three top-level views. No router library: the active page is a
// piece of state in App, and switching is just setting it. Nothing here
// needs URLs (it's a desktop app with one window).
export type Page = 'jobs' | 'inbox' | 'pipeline'

// Tab label, hero title and the one-line subtitle under it. INBOX (was
// QUEUE, JT-18) shows the mail status line instead of a subtitle.
export const PAGES: { page: Page; tab: string; title: string; subtitle: string }[] = [
  {
    page: 'jobs',
    tab: 'jobs',
    title: 'job postings',
    subtitle:
      'curated co-ops and software engineering placements. tracking application status, locations, and deadlines across active recruitment cycles.',
  },
  {
    page: 'inbox',
    tab: 'inbox',
    title: 'inbox',
    subtitle: 'every job email, parsed and matched to its application.',
  },
  {
    page: 'pipeline',
    tab: 'pipeline',
    title: 'pipeline',
    subtitle: 'applications in flight, from submitted through assessments and interviews to an answer.',
  },
]
