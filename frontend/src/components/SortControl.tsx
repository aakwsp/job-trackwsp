import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { textButton } from './styles'

// "[ sort · deadline ]": one bracketed button showing the current choice;
// clicking it opens a small list just under it (JT-39). Shared by INBOX and
// JOBS, for sort and for the view mode (`label="view"`), so the toolbars
// match. Generic over the page's own keys: `<K extends string>` lets each
// page pass its union ('newest' | 'company', the JOBS sorts, the view modes)
// and get it back typed in `onChange`.
//
// The list closes like [ filters ]: outside click, tabbing away, esc (which
// hands focus back to the button). Opening focuses the current choice; ↑/↓
// move between choices, Enter or a click picks one and closes.
export default function SortControl<K extends string>({
  label = 'sort',
  options,
  value,
  onChange,
}: {
  label?: string
  options: { key: K; label: string; title?: string }[]
  value: K
  onChange: (k: K) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find((o) => o.key === value)

  useEffect(() => {
    if (!open) return
    // Focus the current choice once the list is open (and no longer
    // `inert`), so ↑/↓ and Enter work straight away.
    listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Handled here: nothing else (a search box, the record) reacts to it.
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    // Capture, so this esc runs before the page's own esc handlers.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  function pick(k: K) {
    onChange(k)
    setOpen(false)
    triggerRef.current?.focus()
  }

  // ↑/↓ between the choices; the focused one is the one Enter picks.
  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
  }

  return (
    // `relative` anchors the `absolute` list under the button.
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null
        if (open && to && !e.currentTarget.contains(to)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={listId}
        className={`${textButton} ${open ? 'text-text' : 'text-text-muted'}`}
      >
        [ {label} · <span className="text-text">{current?.label ?? value}</span> ]
      </button>

      {/* Like the [ filters ] panel: always mounted so `.reveal` can animate
          it, `inert` while closed. Hairline border on the card surface, no
          radius, no shadow. `min-w-full`: at least as wide as the button. */}
      <div
        id={listId}
        ref={listRef}
        role="menu"
        aria-label={label}
        onKeyDown={onListKey}
        className="reveal absolute top-full left-0 z-30 mt-2 min-w-full"
        data-open={open}
        inert={!open}
      >
        <div className="reveal-inner">
          <div className="flex flex-col border border-rule bg-bg-card py-1.5">
            {options.map((o) => {
              const on = o.key === value
              return (
                <button
                  key={o.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => pick(o.key)}
                  title={o.title}
                  className={`flex cursor-pointer items-center gap-2.5 px-3.5 py-1 text-left whitespace-nowrap hover:bg-bg-active hover:text-text focus-visible:bg-bg-active focus-visible:outline-none ${
                    on ? 'text-text' : 'text-text-muted'
                  }`}
                >
                  {/* The current choice is marked, like the filter rows. */}
                  <span className={on ? 'text-text' : 'text-text-dim'}>{on ? '[•]' : '[ ]'}</span>
                  {o.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
