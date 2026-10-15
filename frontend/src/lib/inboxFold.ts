// Which INBOX sections are folded, kept in localStorage so it survives
// restarts (same reasoning and try/catch as `loadView` in view.ts: a broken
// preference must never stop the list from rendering).

export type FoldKey = 'checking' | 'auto' | 'checked'

const STORAGE_KEY = 'jt.inbox.folded'
const KEYS: FoldKey[] = ['checking', 'auto', 'checked']

export function loadFolded(): Set<FoldKey> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? KEYS.filter((k) => raw.includes(k)) : [])
  } catch {
    return new Set()
  }
}

export function saveFolded(s: Set<FoldKey>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]))
  } catch {
    // not saved; it still works for this session
  }
}
