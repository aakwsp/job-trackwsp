// One word of a text option group ("sort newest company", "view def comp
// line"): the active one in text colour with a hairline under it.
export default function OptionButton({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean
  onClick: () => void
  title?: string
  children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`h-7 cursor-pointer appearance-none border-b bg-transparent px-1.5 hover:text-text ${
        on ? 'border-text text-text' : 'border-transparent text-text-dim'
      }`}
    >
      {children}
    </button>
  )
}
