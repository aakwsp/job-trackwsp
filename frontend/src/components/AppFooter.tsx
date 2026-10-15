import type { StatusColor } from '../types'

const QUAD: StatusColor[] = ['pink', 'blue', 'green', 'sand']

// Bottom of every view: credit on the left; the four status colours as
// small squares and the year on the right.
export default function AppFooter() {
  return (
    <footer className="mt-auto flex items-center justify-between border-t border-rule-strong px-6 py-6 text-meta text-text-muted">
      <span>designed by aakwsp // moshi</span>
      <span className="flex items-center gap-4">
        <span className="flex gap-1" aria-hidden>
          {QUAD.map((c) => (
            <span key={c} className="flag" data-color={c} />
          ))}
        </span>
        <span className="text-text-dim">© {new Date().getFullYear()}</span>
      </span>
    </footer>
  )
}
