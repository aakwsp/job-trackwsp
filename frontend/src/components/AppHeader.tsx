import { PAGES, type Page } from '../lib/page'

type Props = {
  page: Page
  onPage: (p: Page) => void
}

// "job trackwsp" on the left, the three view tabs on the right. The active
// tab is a solid parchment block with dark text; the others are plain text.
export default function AppHeader({ page, onPage }: Props) {
  return (
    <header className="flex items-center justify-between border-b border-rule-strong px-4 py-3">
      <span className="font-serif text-brand leading-none">job trackwsp</span>
      <nav className="flex items-center gap-1">
        {PAGES.map((p, i) => (
          <button
            key={p.page}
            type="button"
            onClick={() => onPage(p.page)}
            // The native hover tooltip names the shortcut (App handles it).
            title={`${p.tab} · ctrl+${i + 1}`}
            aria-keyshortcuts={`Control+${i + 1}`}
            // aria-current tells screen readers which tab is the open page.
            aria-current={page === p.page ? 'page' : undefined}
            className={`tab ${page === p.page ? 'tab-active' : ''}`}
          >
            {p.tab}
          </button>
        ))}
      </nav>
    </header>
  )
}
